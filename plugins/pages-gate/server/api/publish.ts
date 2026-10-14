import httpErrors from "http-errors";
import Router from "koa-router";
import { Op } from "sequelize";
import env from "@server/env";
import { InternalError, NotFoundError, ValidationError } from "@server/errors";
import Logger from "@server/logging/Logger";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import timeout from "@server/middlewares/timeout";
import { transaction } from "@server/middlewares/transaction";
import validate from "@server/middlewares/validate";
import {
  Collection,
  Document,
  PagesDomain,
  PagesPublication,
  PagesSite,
  type User,
} from "@server/models";
import { PagesSourceType } from "@server/models/PagesPublication";
import { PagesSiteStatus } from "@server/models/PagesSite";
import { authorize, can } from "@server/policies";
import type { APIContext } from "@server/types";
import { AuthenticationType } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import { makeBeaconDecorator } from "../lib/beacon";
import { sitePrefix } from "../lib/keys";
import type { ObjectStore } from "../lib/objectStore";
import type { RenderInput } from "../lib/renderPages";
import "../policies";
import {
  pagesSiteIncludes,
  presentPagesSite,
  publishedUrl,
} from "../presenters/pagesSite";
import * as T from "./schema";

type Source = { type: "document" | "collection"; id: string };

/**
 * Socket timeout for the routes that write a whole site. Publish and rotate
 * hold the one-time code in their response, so the default 10 s would drop a
 * code that was already committed on a large site.
 */
export const PUBLISH_TIMEOUT_MS = 120_000;

/** Returns the raw object store, possibly building it on first use. */
export type StoreFactory = () => ObjectStore | Promise<ObjectStore>;

// Imported on first use, not at load: the test setup imports every plugin
// entry point, and a static import would pin these modules (and the S3 SDK)
// before a test file could mock them.
const libs = async () => ({
  ...(await import("../lib/objectStore")),
  ...(await import("../lib/publish")),
  ...(await import("../lib/renderPages")),
});

/**
 * Builds the routes that publish, rotate, unpublish and delete gated sites.
 *
 * The publish body holds the access code and the publish and rotate responses
 * hold a new one: never pass `ctx.request.body`, `ctx.input`, the destructured
 * body or the response to a logger, error or trace tag.
 *
 * @param storeFactory returns the raw object store; it is always guarded per site.
 * @returns the router.
 */
export function createPublishRouter(storeFactory: StoreFactory): Router {
  const router = new Router();

  // Session only, as for the site routes: API keys and OAuth tokens are refused.
  const sessionAuth = () => auth({ type: AuthenticationType.APP });

  /**
   * Shared by publish and rotate so both load, team-scope, authorize, render
   * and respond identically; only the ability and the publishSite mode differ.
   */
  const publishFromSources = async (
    ctx: APIContext<T.PagesPublishReq> | APIContext<T.PagesRotateReq>,
    mode: { rotate: true } | { rotate: false; accessCode?: string }
  ) => {
    const { id, sources } = ctx.input.body;
    const { user } = ctx.state.auth;

    const site = await PagesSite.findOne({
      where: { id, teamId: user.teamId },
    });
    if (!site) {
      throw NotFoundError();
    }
    authorize(user, mode.rotate ? "rotate" : "publish", site);

    const requested = dedupe(sources ?? (await storedSources(site.id)));
    if (requested.length === 0) {
      throw ValidationError("Choose a document or collection to publish");
    }
    // Every source is loaded and authorized before anything is rendered.
    const loaded = await loadSources(user, requested);
    const lib = await libs();

    try {
      const rendered = await lib.renderPages({
        teamId: user.teamId,
        siteTitle: site.title,
        sources: loaded.sources,
      });
      const result = await lib.publishSite({
        site,
        pages: rendered.pages,
        store: await storeFactory(),
        actorId: user.id,
        ...(mode.rotate ? { rotate: true } : { code: mode.accessCode }),
        // Reads the switch from the row publishSite has locked, so a toggle
        // racing this publish cannot leave the pages out of step with it.
        decoratePage: (html, { pageKey, site: locked }) =>
          locked.measurementEnabled
            ? makeBeaconDecorator({
                endpoint: `${env.URL}/api/pages.ingest`,
                ingestKey: locked.ingestKey,
              })(html, { pageKey })
            : html,
      });
      // The publish has committed and any issued code exists nowhere else:
      // a failed reload must not drop it, so fall back to the site as loaded,
      // updated with what the publish wrote.
      const published = await PagesSite.findByPk(site.id, {
        include: pagesSiteIncludes(),
      }).catch((err: unknown) => {
        Logger.warn("Pages site reload after publish failed", {
          siteId: site.id,
          error: err instanceof Error ? err.name : "unknown",
        });
        return null;
      });
      if (!published) {
        site.status = PagesSiteStatus.Published;
        site.currentVersion = result.version;
      }
      const shown = published ?? site;

      ctx.set("Cache-Control", "no-store");
      ctx.body = {
        data: {
          site: presentPagesSite(shown),
          publishedUrl: publishedUrl(shown),
          pageCount: rendered.pages.length,
          warnings: [
            ...loaded.warnings,
            ...rendered.warnings,
            ...result.warnings,
          ],
          ...(result.issuedCode === undefined
            ? {}
            : { accessCode: result.issuedCode }),
        },
      };
    } catch (err) {
      throw toApiError(err, lib);
    }
  };

  router.post(
    "pages.publish",
    sessionAuth(),
    // Each call derives a key with PBKDF2; this also bounds code guessing.
    rateLimiter(RateLimiterStrategy.FivePerMinute),
    validate(T.PagesPublishSchema),
    timeout(PUBLISH_TIMEOUT_MS),
    (ctx: APIContext<T.PagesPublishReq>) =>
      publishFromSources(ctx, {
        rotate: false,
        accessCode: ctx.input.body.accessCode,
      })
  );

  router.post(
    "pages.rotate",
    sessionAuth(),
    // Each call derives a key with PBKDF2 and replaces readers' access.
    rateLimiter(RateLimiterStrategy.FivePerMinute),
    validate(T.PagesRotateSchema),
    timeout(PUBLISH_TIMEOUT_MS),
    (ctx: APIContext<T.PagesRotateReq>) =>
      publishFromSources(ctx, { rotate: true })
  );

  router.post(
    "pages.unpublish",
    sessionAuth(),
    rateLimiter(RateLimiterStrategy.TenPerMinute),
    validate(T.PagesUnpublishSchema),
    timeout(PUBLISH_TIMEOUT_MS),
    transaction(),
    async (ctx: APIContext<T.PagesUnpublishReq>) => {
      const { id } = ctx.input.body;
      const { user } = ctx.state.auth;
      const { transaction } = ctx.state;

      const site = await PagesSite.findOne({
        where: { id, teamId: user.teamId },
        lock: transaction.LOCK.UPDATE,
        transaction,
      });
      if (!site) {
        throw NotFoundError();
      }
      authorize(user, "unpublish", site);

      await removeSiteObjects(await storeFactory(), site.slug);
      await PagesPublication.destroy({
        where: { siteId: site.id },
        transaction,
      });
      // The old code died with the old pages; the next publish issues a new one.
      await site.update(
        { status: PagesSiteStatus.Unpublished, codeVersion: 0 },
        { transaction }
      );
      site.domains = await PagesDomain.findAll({
        where: { siteId: site.id },
        transaction,
      });
      site.publications = [];

      ctx.body = {
        data: presentPagesSite(site),
      };
    }
  );

  router.post(
    "pages.delete",
    sessionAuth(),
    rateLimiter(RateLimiterStrategy.TenPerMinute),
    validate(T.PagesDeleteSchema),
    timeout(PUBLISH_TIMEOUT_MS),
    transaction(),
    async (ctx: APIContext<T.PagesDeleteReq>) => {
      const { id } = ctx.input.body;
      const { user } = ctx.state.auth;
      const { transaction } = ctx.state;

      const site = await PagesSite.findOne({
        where: { id, teamId: user.teamId },
        lock: transaction.LOCK.UPDATE,
        transaction,
      });
      if (!site) {
        throw NotFoundError();
      }
      authorize(user, "delete", site);

      await removeSiteObjects(await storeFactory(), site.slug);
      await site.destroy({ transaction });

      ctx.body = {
        success: true,
      };
    }
  );

  return router;
}

/** The distinct sources of a site's current publications, oldest first. */
async function storedSources(siteId: string): Promise<Source[]> {
  const rows = await PagesPublication.findAll({
    where: { siteId },
    attributes: ["sourceType", "sourceId"],
    order: [
      ["createdAt", "ASC"],
      ["pageKey", "ASC"],
    ],
  });
  return rows.map((row) => ({
    type:
      row.sourceType === PagesSourceType.Document ? "document" : "collection",
    id: row.sourceId,
  }));
}

function dedupe(sources: Source[]): Source[] {
  const unique = new Map<string, Source>();
  for (const source of sources) {
    unique.set(`${source.type}:${source.id}`, source);
  }
  return [...unique.values()];
}

/**
 * Loads each source within the actor's team and authorizes it. A missing or
 * foreign source is a 404 and an unreadable one a 403, before anything is
 * rendered; unreadable documents of a collection are skipped with a warning.
 */
async function loadSources(
  user: User,
  requested: Source[]
): Promise<{ sources: RenderInput["sources"]; warnings: string[] }> {
  const sources: RenderInput["sources"] = [];
  let skipped = 0;

  for (const source of requested) {
    if (source.type === "document") {
      const document = await Document.findByPk(source.id, {
        userId: user.id,
      });
      if (!document || document.teamId !== user.teamId) {
        throw NotFoundError();
      }
      authorize(user, "read", document);
      sources.push({ type: "document", document });
      continue;
    }

    const collection = await Collection.findByPk(source.id, {
      userId: user.id,
    });
    if (!collection || collection.teamId !== user.teamId) {
      throw NotFoundError();
    }
    authorize(user, "read", collection);
    // shortcut: loads every published document of the collection before the
    // 50-document cap applies; add a count query if collections grow large.
    const documents = await Document.withMembershipScope(user.id).findAll({
      where: {
        teamId: user.teamId,
        collectionId: collection.id,
        publishedAt: { [Op.ne]: null },
        archivedAt: null,
      },
      order: [["title", "ASC"]],
    });
    const readable = documents.filter((document) =>
      can(user, "read", document)
    );
    skipped += documents.length - readable.length;
    sources.push({ type: "collection", collection, documents: readable });
  }

  // No titles: the actor may not know these documents exist.
  const warnings =
    skipped > 0
      ? [`Skipped ${skipped} document(s) you do not have permission to read.`]
      : [];
  return { sources, warnings };
}

/**
 * Deletes every object of a site, then lists again and refuses to continue
 * unless none remain, since a listing can undercount.
 */
async function removeSiteObjects(store: ObjectStore, slug: string) {
  const { createGuardedStore } = await libs();
  const guarded = createGuardedStore(store, slug);
  await guarded.removeAll();
  const remaining = await guarded.list(sitePrefix(slug));
  if (remaining.length > 0) {
    throw InternalError("Some published files could not be removed");
  }
}

/** Maps publishing errors to API errors with a stable `error` reason. */
function toApiError(
  err: unknown,
  lib: Awaited<ReturnType<typeof libs>>
): unknown {
  const fail = (
    status: number,
    message: string,
    id: string,
    errorData?: Record<string, number>
  ) => httpErrors(status, message, { id, isReportable: false, errorData });

  if (err instanceof lib.AccessCodeRequiredError) {
    return fail(400, err.message, "access_code_required");
  }
  if (err instanceof lib.IncorrectCodeError) {
    return fail(400, err.message, "incorrect_code");
  }
  if (err instanceof lib.NoLivePageError) {
    return fail(409, err.message, "rotation_required");
  }
  if (err instanceof lib.NothingToRotateError) {
    return fail(409, err.message, "nothing_to_rotate");
  }
  if (err instanceof lib.EmptySiteError) {
    return fail(400, err.message, "empty_site");
  }
  if (err instanceof lib.TooManyDocumentsError) {
    return fail(400, err.message, "too_many_documents", {
      count: err.count,
      limit: err.limit,
    });
  }
  if (err instanceof lib.PageTooLargeError) {
    return fail(400, err.message, "page_too_large", {
      bytes: err.bytes,
      limit: err.limit,
    });
  }
  return err;
}
