import { randomBytes } from "node:crypto";
import Router from "koa-router";
import { UniqueConstraintError } from "sequelize";
import { NotFoundError, ValidationError } from "@server/errors";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import timeout from "@server/middlewares/timeout";
import validate from "@server/middlewares/validate";
import { Attachment, Document, PagesSite } from "@server/models";
import { PagesSiteKind, PagesSiteStatus } from "@server/models/PagesSite";
import { authorize } from "@server/policies";
import FileStorage from "@server/storage/files";
import type { APIContext } from "@server/types";
import { AuthenticationType } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import { PagesGateType } from "../../shared/accessCode";
import { BUNDLE_LIMITS, BundleError, readBundle } from "../lib/artifactBundle";
import { artifactPrefix, createArtifactStore } from "../lib/artifactStore";
import { InvalidSlugError, assertValidSlug } from "../lib/keys";
import { ReadCapExceededError, readCapped } from "../lib/readCapped";
import "../policies";
import { presentPagesSite, publishedUrl } from "../presenters/pagesSite";
import { PUBLISH_TIMEOUT_MS, type StoreFactory } from "./publish";
import * as T from "./schema";

const TAKEN = "That address is already taken";

/**
 * Builds the route that publishes an uploaded artifact (one HTML file or a
 * zip of a static site) to the public bucket under `artifacts/<slug>/`.
 *
 * Open to a session and to API keys: the acting user must still be a Pages
 * admin, and a key's scope must allow `/api/pages.publishArtifact`.
 *
 * @param storeFactory returns the raw object store; it is always guarded per site.
 * @returns the router.
 */
export function createArtifactPublishRouter(
  storeFactory: StoreFactory
): Router {
  const router = new Router();

  router.post(
    "pages.publishArtifact",
    // The middleware enforces an API key's scope against the path.
    auth({ type: [AuthenticationType.APP, AuthenticationType.API] }),
    // A fixed path, so the limiter map holds exactly one entry for it.
    rateLimiter(RateLimiterStrategy.TenPerMinute),
    validate(T.PagesPublishArtifactSchema),
    timeout(PUBLISH_TIMEOUT_MS),
    async (ctx: APIContext<T.PagesPublishArtifactReq>) => {
      const { documentId, attachmentId, title, slug } = ctx.input.body;
      const { user } = ctx.state.auth;

      if (slug !== undefined) {
        try {
          assertValidSlug(slug);
        } catch (err) {
          if (err instanceof InvalidSlugError) {
            throw ValidationError(`Invalid address: ${err.reason}`);
          }
          throw err;
        }
      }

      const document = await Document.findByPk(documentId, {
        userId: user.id,
      });
      if (!document || document.teamId !== user.teamId) {
        throw NotFoundError();
      }
      authorize(user, "update", document);

      const attachment = await Attachment.findOne({
        where: {
          id: attachmentId,
          teamId: user.teamId,
          documentId: document.id,
        },
      });
      if (!attachment) {
        throw NotFoundError();
      }

      // A site that exists but is not ours (another team, or a pages site)
      // gets the same message as a taken one, so nothing about it leaks.
      let site = slug ? await PagesSite.findOne({ where: { slug } }) : null;
      if (
        site &&
        (site.teamId !== user.teamId || site.kind !== PagesSiteKind.Artifact)
      ) {
        throw ValidationError(TAKEN);
      }
      if (site) {
        authorize(user, "publish", site);
      } else {
        authorize(user, "createPagesSite", user.team);
      }

      // Refuse before loading an oversized upload into memory.
      if (Number(attachment.size) > BUNDLE_LIMITS.totalBytes) {
        throw ValidationError("The file is too large");
      }
      const stream = await FileStorage.getFileStream(attachment.key);
      if (!stream) {
        throw new Error("No stream available");
      }
      // The declared size is client-supplied, so cap the real read too.
      let bytes: Buffer;
      try {
        bytes = await readCapped(stream, BUNDLE_LIMITS.totalBytes);
      } catch (err) {
        if (err instanceof ReadCapExceededError) {
          throw ValidationError("The file is too large");
        }
        throw err;
      }
      let bundle: Awaited<ReturnType<typeof readBundle>>;
      try {
        bundle = await readBundle(attachment.name, bytes);
      } catch (err) {
        if (err instanceof BundleError) {
          throw ValidationError(err.message);
        }
        throw err;
      }

      if (!site) {
        const newSlug = slug ?? randomBytes(8).toString("hex");
        try {
          // Draft first: if the upload below fails the row is visible and
          // deletable, and never claims to be published.
          site = await PagesSite.create({
            teamId: user.teamId,
            createdById: user.id,
            slug: newSlug,
            title: title ?? attachment.name.replace(/\.(html?|zip)$/i, ""),
            kind: PagesSiteKind.Artifact,
            gateType: PagesGateType.None,
            prefix: artifactPrefix(newSlug),
            status: PagesSiteStatus.Draft,
          });
        } catch (err) {
          if (err instanceof UniqueConstraintError) {
            throw ValidationError(TAKEN);
          }
          throw err;
        }
      }

      const files = createArtifactStore(await storeFactory(), site.slug);
      const before = await files.list();
      for (const file of bundle.files) {
        await files.put(file.path, file.body, {
          contentType: file.contentType,
          // Short, so a republish shows up within minutes.
          cacheControl: "public, max-age=300",
        });
      }
      const keep = new Set(bundle.files.map((file) => file.path));
      for (const stale of before.filter((path) => !keep.has(path))) {
        await files.delete(stale);
      }

      await site.update({
        status: PagesSiteStatus.Published,
        title: title ?? site.title,
        currentVersion: site.currentVersion + 1,
      });

      ctx.set("Cache-Control", "no-store");
      ctx.body = {
        data: {
          site: presentPagesSite(site),
          publishedUrl: publishedUrl(site),
          fileCount: bundle.files.length,
        },
      };
    }
  );

  return router;
}
