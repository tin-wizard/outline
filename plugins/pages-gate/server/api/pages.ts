import Router from "koa-router";
import { Op, UniqueConstraintError, type WhereOptions } from "sequelize";
import env from "@server/env";
import { InternalError, NotFoundError, ValidationError } from "@server/errors";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import { transaction } from "@server/middlewares/transaction";
import validate from "@server/middlewares/validate";
import { PagesDomain, PagesSite } from "@server/models";
import { PagesSiteStatus } from "@server/models/PagesSite";
import { authorize } from "@server/policies";
import pagination, {
  paginateQuery,
} from "@server/routes/api/middlewares/pagination";
import { QueryHelper } from "@server/storage/QueryHelper";
import type { APIContext } from "@server/types";
import { AuthenticationType } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import pagesEnv from "../env";
import {
  InvalidHostnameError,
  RESERVED_HOST_SUFFIXES,
  validateHostname,
} from "../lib/hostnames";
import { loadInsights } from "../lib/insights";
import { InvalidSlugError, sitePrefix } from "../lib/keys";
import type { ObjectStore } from "../lib/objectStore";
import "../policies";
import { pagesSiteIncludes, presentPagesSite } from "../presenters/pagesSite";
import { createIngestRouter } from "./ingest";
import { type StoreFactory, createPublishRouter } from "./publish";
import * as T from "./schema";

const router = new Router();

// Session only: API keys and OAuth tokens are refused. No role option, since
// that would refuse platform admins without the admin role; the policies
// decide instead.
const sessionAuth = () => auth({ type: AuthenticationType.APP });

router.post(
  "pages.list",
  sessionAuth(),
  pagination(),
  validate(T.PagesListSchema),
  async (ctx: APIContext<T.PagesListReq>) => {
    const { query } = ctx.input.body;
    const { user } = ctx.state.auth;

    authorize(user, "listPagesSite", user.team);

    const where: WhereOptions<PagesSite> = query
      ? {
          teamId: user.teamId,
          [Op.or]: [
            { title: { [Op.iLike]: QueryHelper.likeContains(query) } },
            { slug: { [Op.iLike]: QueryHelper.likeContains(query) } },
          ],
        }
      : { teamId: user.teamId };

    const { results, pagination } = await paginateQuery(
      ctx,
      (opts) =>
        PagesSite.findAll({
          where,
          include: pagesSiteIncludes(),
          order: [
            ["createdAt", "DESC"],
            ["id", "DESC"],
          ],
          offset: opts.offset,
          limit: opts.limit,
        }),
      () => PagesSite.count({ where })
    );

    ctx.body = {
      pagination,
      data: results.map(presentPagesSite),
    };
  }
);

router.post(
  "pages.info",
  sessionAuth(),
  validate(T.PagesInfoSchema),
  async (ctx: APIContext<T.PagesInfoReq>) => {
    const { id } = ctx.input.body;
    const { user } = ctx.state.auth;

    // Scoped to the actor's team so another team's site is a 404, never 403.
    const site = await PagesSite.findOne({
      where: { id, teamId: user.teamId },
      include: pagesSiteIncludes(),
    });
    if (!site) {
      throw NotFoundError();
    }

    authorize(user, "read", site);

    ctx.body = {
      data: presentPagesSite(site),
    };
  }
);

router.post(
  "pages.insights",
  sessionAuth(),
  rateLimiter(RateLimiterStrategy.TwentyFivePerMinute),
  validate(T.PagesInsightsSchema),
  async (ctx: APIContext<T.PagesInsightsReq>) => {
    const { id, period, days } = ctx.input.body;
    const { user } = ctx.state.auth;

    const site = await PagesSite.findOne({
      where: { id, teamId: user.teamId },
    });
    if (!site) {
      throw NotFoundError();
    }

    authorize(user, "read", site);

    const retentionDays = pagesEnv.PAGES_EVENT_RETENTION_DAYS;
    const insights = await loadInsights({
      siteId: site.id,
      period,
      days,
      now: Date.now(),
      retentionDays,
    });

    ctx.set("Cache-Control", "no-store");
    ctx.body = {
      data: {
        ...insights,
        measurementEnabled: site.measurementEnabled,
        retentionDays,
      },
    };
  }
);

router.post(
  "pages.create",
  sessionAuth(),
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  validate(T.PagesCreateSchema),
  transaction(),
  async (ctx: APIContext<T.PagesCreateReq>) => {
    const { slug, title, measurementEnabled, hostname } = ctx.input.body;
    const { user } = ctx.state.auth;
    const { transaction } = ctx.state;

    authorize(user, "createPagesSite", user.team);

    let prefix: string;
    try {
      prefix = sitePrefix(slug);
    } catch (err) {
      if (err instanceof InvalidSlugError) {
        throw ValidationError(`The address ${err.reason}`);
      }
      throw err;
    }

    let domainHostname: string | undefined;
    if (hostname !== undefined) {
      try {
        domainHostname = validateHostname(hostname, reservedHosts());
      } catch (err) {
        if (err instanceof InvalidHostnameError) {
          throw ValidationError(`The domain ${err.reason}`);
        }
        throw err;
      }
    }

    try {
      const site = await PagesSite.create(
        {
          slug,
          title,
          prefix,
          status: PagesSiteStatus.Draft,
          gateType: "code",
          measurementEnabled: measurementEnabled ?? false,
          teamId: user.teamId,
          createdById: user.id,
        },
        { transaction }
      );
      site.domains = domainHostname
        ? [
            await PagesDomain.create(
              { siteId: site.id, hostname: domainHostname },
              { transaction }
            ),
          ]
        : [];

      ctx.body = {
        data: presentPagesSite(site),
      };
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw ValidationError(
          "hostname" in err.fields
            ? "This domain is already in use"
            : "This address is already in use"
        );
      }
      throw err;
    }
  }
);

router.post(
  "pages.update",
  sessionAuth(),
  rateLimiter(RateLimiterStrategy.TwentyFivePerMinute),
  validate(T.PagesUpdateSchema),
  transaction(),
  async (ctx: APIContext<T.PagesUpdateReq>) => {
    const { id, title, measurementEnabled } = ctx.input.body;
    const { user } = ctx.state.auth;
    const { transaction } = ctx.state;

    const site = await PagesSite.findOne({
      where: { id, teamId: user.teamId },
      include: pagesSiteIncludes(),
      transaction,
    });
    if (!site) {
      throw NotFoundError();
    }

    authorize(user, "update", site);

    // Only these two fields are writable; slug, status, prefix and versions
    // are not in the schema and so never reach here.
    if (title !== undefined) {
      site.title = title;
    }
    if (measurementEnabled !== undefined) {
      site.measurementEnabled = measurementEnabled;
    }
    await site.save({ transaction });

    ctx.body = {
      data: presentPagesSite(site),
    };
  }
);

/**
 * Hosts a custom domain may not equal or sit under: this instance, the public
 * pages host and the operator's own domains.
 */
function reservedHosts(): string[] {
  return [env.URL, pagesEnv.PAGES_PUBLIC_BASE_URL]
    .filter((url): url is string => Boolean(url))
    .map((url) => new URL(url).hostname)
    .concat(RESERVED_HOST_SUFFIXES);
}

/**
 * Builds the plugin's API router.
 *
 * @param deps optional dependencies; tests inject an in-memory object store.
 * The default factory builds the R2 store from the plugin env on first use.
 * @returns the router with the site, publishing and ingest routes.
 */
export function createPagesRouter(
  deps: { storeFactory?: StoreFactory } = {}
): Router {
  const pagesRouter = new Router();
  pagesRouter.use(router.routes());
  pagesRouter.use(
    createPublishRouter(deps.storeFactory ?? defaultStore).routes()
  );
  // The one route without auth(); every other route declares its own.
  pagesRouter.use(createIngestRouter().routes());
  return pagesRouter;
}

let r2Store: ObjectStore | undefined;

/** Builds the R2 store from the plugin env on first use, never at import. */
async function defaultStore(): Promise<ObjectStore> {
  if (!r2Store) {
    const { createR2Client, createR2Store } =
      await import("../lib/objectStore");
    const {
      PAGES_R2_ACCOUNT_ID,
      PAGES_R2_ACCESS_KEY_ID,
      PAGES_R2_SECRET_ACCESS_KEY,
      PAGES_R2_BUCKET,
    } = pagesEnv;
    if (
      !PAGES_R2_ACCOUNT_ID ||
      !PAGES_R2_ACCESS_KEY_ID ||
      !PAGES_R2_SECRET_ACCESS_KEY ||
      !PAGES_R2_BUCKET
    ) {
      throw InternalError("Pages storage is not configured");
    }
    r2Store = createR2Store({
      client: createR2Client({
        accountId: PAGES_R2_ACCOUNT_ID,
        accessKeyId: PAGES_R2_ACCESS_KEY_ID,
        secretAccessKey: PAGES_R2_SECRET_ACCESS_KEY,
      }),
      bucket: PAGES_R2_BUCKET,
    });
  }
  return r2Store;
}

export default createPagesRouter();
