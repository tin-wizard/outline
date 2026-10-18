import { isHttpError } from "http-errors";
import { RateLimiterRes } from "rate-limiter-flexible";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import AuthenticationHelper from "@shared/helpers/AuthenticationHelper";
import { type ProsemirrorData, TextEditMode } from "@shared/types";
import { toError } from "@shared/utils/error";
import documentUpdater from "@server/commands/documentUpdater";
import env from "@server/env";
import {
  NotFoundError,
  RateLimitExceededError,
  ValidationError,
} from "@server/errors";
import Logger from "@server/logging/Logger";
import { Attachment, Document, type User } from "@server/models";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { authorize, can } from "@server/policies";
import { sequelize } from "@server/storage/database";
import Redis from "@server/storage/redis";
import {
  buildAPIContext,
  error,
  success,
  withTracing,
} from "@server/tools/util";
import RateLimiter, { RateLimiterStrategy } from "@server/utils/RateLimiter";
import type { StoreFactory } from "./api/publish";
import { readAttachmentBytes } from "./lib/artifactUpload";
import { defaultStore } from "./lib/defaultStore";
import { publishArtifact } from "./lib/publishArtifact";
import "./policies";
import { publishedUrl } from "./presenters/pagesSite";

/**
 * The longest inline html accepted, in characters. JSON escaping and multi-byte
 * UTF-8 must still fit the 1 MB /mcp body limit; larger artifacts go through an attachment.
 */
export const MAX_HTML_LENGTH = 400_000;

/** The key the per-user publish limiter is registered under. */
const RATE_LIMIT_KEY = "mcp:publish_artifact";

const NOTE =
  "Pass the same slug to update this artifact. Unpublish or delete it in Settings -> Pages.";

const DESCRIPTION =
  "Publishes an interactive HTML artifact (a single self-contained HTML file, or the id of an uploaded .html/.zip attachment) as a PUBLIC web page on the TIN Pages site and returns its public URL. Anyone with the link can open it without logging in: never publish confidential content. Pass `documentId` to also embed the live page in that document. Pass the same `slug` again to update an existing artifact. Requires a Pages administrator. Inline html is for artifacts up to about 400 KB; for larger ones upload the file with create_attachment and pass attachmentId instead of html. External scripts and network requests are blocked on the published page: inline everything.";

/**
 * Registers the Pages MCP tools: `publish_artifact`, only for tokens whose
 * scopes allow `pages.publishArtifact` (a write scope).
 *
 * @param server the MCP server for the current request.
 * @param scopes the scopes granted to the access token.
 * @param storeFactory returns the raw object store; defaults to the R2 store.
 */
export function pagesMcpTools(
  server: McpServer,
  scopes: string[],
  storeFactory: StoreFactory = defaultStore
): void {
  if (!AuthenticationHelper.canAccess("pages.publishArtifact", scopes)) {
    return;
  }

  server.registerTool(
    "publish_artifact",
    {
      title: "Publish artifact",
      description: DESCRIPTION,
      annotations: {
        idempotentHint: false,
        readOnlyHint: false,
      },
      inputSchema: {
        html: z
          .string()
          .min(1)
          .max(MAX_HTML_LENGTH)
          .optional()
          .describe(
            "A complete, self-contained HTML document to publish as index.html. Provide this or attachmentId, not both."
          ),
        attachmentId: z
          .string()
          .uuid()
          .optional()
          .describe(
            "The id of an uploaded .html or .zip attachment (see create_attachment) to publish. Provide this or html, not both."
          ),
        slug: z
          .string()
          .optional()
          .describe(
            "The address of the artifact. Reuse an existing slug to update that artifact; omit for a new random address."
          ),
        title: z.string().optional().describe("A title for the artifact."),
        documentId: z
          .string()
          .uuid()
          .optional()
          .describe(
            "A document to embed the published page in, appended at its end. Requires permission to edit it."
          ),
      },
    },
    withTracing("publish_artifact", async (input, context) => {
      try {
        const ctx = buildAPIContext(context);
        const { user } = ctx.state.auth;
        const { html, attachmentId, slug, title, documentId } = input;

        if ((html === undefined) === (attachmentId === undefined)) {
          throw ValidationError("Provide exactly one of html or attachmentId");
        }

        // First, so a non-admin never reaches a slug, document or attachment lookup.
        authorize(user, "createPagesSite", user.team);
        await consumePublishPoint(user);

        if (documentId) {
          const document = await Document.findByPk(documentId, {
            userId: user.id,
          });
          if (!document || document.teamId !== user.teamId) {
            throw NotFoundError();
          }
          authorize(user, "update", document);
        }

        let fileName = "index.html";
        let readBytes: () => Promise<Buffer> = async () =>
          Buffer.from(html ?? "", "utf8");
        if (attachmentId) {
          const attachment = await loadUsableAttachment(user, attachmentId);
          fileName = attachment.name;
          readBytes = () => readAttachmentBytes(attachment);
        }

        const { site, fileCount } = await publishArtifact({
          user,
          slug,
          title,
          fileName,
          readBytes,
          storeFactory,
        });
        const url = publishedUrl(site);

        let embedAdded = false;
        let note = NOTE;
        if (documentId && !url) {
          note = `No embed was added: the public Pages URL is not configured. ${NOTE}`;
        }
        if (documentId && url) {
          // The page is already public: an embed failure must not hide its URL.
          try {
            const alreadyEmbedded = await sequelize.transaction(
              async (transaction) => {
                ctx.state.transaction = transaction;
                ctx.context.transaction = transaction;

                const document = await Document.findByPk(documentId, {
                  userId: user.id,
                  includeState: true,
                  rejectOnEmpty: true,
                  transaction,
                });
                authorize(user, "update", document);

                // The URL is stable per slug, so a republish must not stack embeds.
                // content can be null on older documents, so read the full tree (content, state or text).
                if (
                  hasEmbed(DocumentHelper.toProsemirror(document).toJSON(), url)
                ) {
                  return true;
                }
                await documentUpdater(ctx, {
                  document,
                  text: `[${url}](${url})`,
                  editMode: TextEditMode.Append,
                });
                return false;
              }
            );
            embedAdded = true;
            if (alreadyEmbedded) {
              note = `The document already embeds this page. ${NOTE}`;
            }
          } catch (err) {
            Logger.error("Failed to embed a published artifact", toError(err), {
              documentId,
              siteId: site.id,
            });
            // Only messages meant for clients are passed on; anything else may be internal.
            const reason =
              isHttpError(err) && err.expose
                ? err.message
                : "an unexpected error occurred";
            note = `The page was published, but the embed could not be added to the document (${reason}). ${NOTE}`;
          }
        }

        return success({
          publishedUrl: url,
          slug: site.slug,
          siteId: site.id,
          fileCount,
          version: site.currentVersion,
          embedAdded,
          note,
        });
      } catch (err) {
        return error(err);
      }
    })
  );
}

/**
 * Whether a ProseMirror tree contains an embed node pointing at the URL.
 *
 * @param node the document content.
 * @param url the embed href to look for.
 * @returns true when such an embed exists.
 */
function hasEmbed(
  node: ProsemirrorData | null | undefined,
  url: string
): boolean {
  if (!node) {
    return false;
  }
  if (node.type === "embed" && node.attrs?.href === url) {
    return true;
  }
  return (node.content ?? []).some((child) => hasEmbed(child, url));
}

/**
 * Loads an attachment the user may publish: their own upload not yet on a
 * document, or one on a document they can update. Anything else, including
 * another team's attachment, is reported as not found.
 *
 * @param user the acting user.
 * @param id the attachment id.
 * @returns the attachment.
 * @throws NotFoundError when the attachment is missing or not usable.
 */
async function loadUsableAttachment(user: User, id: string) {
  const attachment = await Attachment.findOne({
    where: { id, teamId: user.teamId },
  });
  if (!attachment) {
    throw NotFoundError();
  }
  if (attachment.documentId === null) {
    if (attachment.userId === user.id) {
      return attachment;
    }
    throw NotFoundError();
  }
  const document = await Document.findByPk(attachment.documentId, {
    userId: user.id,
  });
  if (
    document &&
    document.teamId === user.teamId &&
    can(user, "update", document)
  ) {
    return attachment;
  }
  throw NotFoundError();
}

/**
 * Charges one publish against the user's per-minute allowance, as the API
 * rate limiter middleware does for a route.
 *
 * @param user the acting user.
 * @throws RateLimitExceededError when the allowance is used up.
 */
async function consumePublishPoint(user: User): Promise<void> {
  if (!env.RATE_LIMITER_ENABLED) {
    return;
  }
  if (!RateLimiter.hasRateLimiter(RATE_LIMIT_KEY)) {
    const { duration, requests } = RateLimiterStrategy.TenPerMinute;
    RateLimiter.setRateLimiter(RATE_LIMIT_KEY, {
      duration,
      points: Math.max(1, Math.round(requests * env.RATE_LIMITER_MULTIPLIER)),
      keyPrefix: RateLimiter.RATE_LIMITER_REDIS_KEY_PREFIX,
      storeClient: Redis.defaultClient,
    });
  }
  try {
    await RateLimiter.getRateLimiter(RATE_LIMIT_KEY).consume(
      `${RATE_LIMIT_KEY}:${user.id}`
    );
  } catch (res) {
    if (res instanceof RateLimiterRes) {
      throw RateLimitExceededError();
    }
    // An unreachable store must not take publishing down, as in the middleware.
    Logger.error("Rate limiter error", toError(res));
  }
}
