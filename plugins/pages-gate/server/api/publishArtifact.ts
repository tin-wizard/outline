import Router from "koa-router";
import { NotFoundError } from "@server/errors";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import timeout from "@server/middlewares/timeout";
import validate from "@server/middlewares/validate";
import { Attachment, Document } from "@server/models";
import { authorize } from "@server/policies";
import type { APIContext } from "@server/types";
import { AuthenticationType } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import { readAttachmentBytes } from "../lib/artifactUpload";
import { publishArtifact } from "../lib/publishArtifact";
import "../policies";
import { presentPagesSite, publishedUrl } from "../presenters/pagesSite";
import { PUBLISH_TIMEOUT_MS, type StoreFactory } from "./publish";
import * as T from "./schema";

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

      const { site, fileCount } = await publishArtifact({
        user,
        slug,
        title,
        fileName: attachment.name,
        readBytes: () => readAttachmentBytes(attachment),
        storeFactory,
      });

      ctx.set("Cache-Control", "no-store");
      ctx.body = {
        data: {
          site: presentPagesSite(site),
          publishedUrl: publishedUrl(site),
          fileCount,
        },
      };
    }
  );

  return router;
}
