import { randomUUID } from "node:crypto";
import Router from "koa-router";
import { QueryTypes } from "sequelize";
import { ValidationError } from "@server/errors";
import Logger from "@server/logging/Logger";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import { PagesPublication, PagesSite } from "@server/models";
import { PagesSiteStatus } from "@server/models/PagesSite";
import { sequelize } from "@server/storage/database";
import Redis from "@server/storage/redis";
import { requestContext } from "@server/storage/requestContext";
import type { AppContext } from "@server/types";
import { type PagesIngestEvent, PagesIngestEventSchema } from "./schema";

/**
 * Per client IP. A heartbeat every 15 s is at most 4 a minute per active tab
 * (an idle tab sends none), plus a view and an end per page, so 1,800 a
 * minute lets about 400 active tabs share one NAT while a single source
 * flooding at 30 a second is cut off.
 */
export const INGEST_RATE_LIMIT = { duration: 60, requests: 1800 };

/**
 * Accepted events per site per minute; more are dropped with a 204 and a
 * throttled warning in the log.
 */
export const SITE_EVENTS_PER_MINUTE = 1200;

/**
 * How long the site and page lookup is reused. A measurement toggle, an
 * unpublish or a new publication takes effect within this time.
 */
export const INGEST_CACHE_TTL_MS = 30_000;

/** At most this many published pages are held in the lookup. */
const MAX_CACHED_PAGES = 20_000;

/** At most this many accepted events are being written at once. */
const MAX_PENDING_WRITES = 256;

const MAX_BODY_BYTES = 1024;
const MAX_ACTIVE_SECONDS = 28800;
const PAST_WINDOW_SECONDS = 24 * 60 * 60;
const FUTURE_WINDOW_SECONDS = 300;
const WARNING_INTERVAL_MS = 60_000;
const ELAPSED_GRACE_SECONDS = 30;
const INVALID = "Invalid event";

interface IngestTarget {
  siteId: string;
  pageKeys: Set<string>;
}

/**
 * Builds the router for the public measurement ingest route. It is the only
 * plugin route without authentication.
 *
 * @returns the router with pages.ingest.
 */
export function createIngestRouter(): Router {
  const router = new Router();

  router.post(
    "pages.ingest",
    rateLimiter(INGEST_RATE_LIMIT),
    async (ctx: AppContext) => {
      const event = parseEvent(ctx);
      const now = Date.now();
      const country = countryOf(ctx.get("cf-ipcountry"));

      // The lookup is awaited for every key alike. An accepted event's write
      // is only started here, not awaited: the response does not wait for it,
      // so an accepted and a dropped event take the same time to answer and
      // cannot be told apart (only the synchronous start of the write differs).
      const target = (await lookup()).get(event.k);
      if (target?.pageKeys.has(event.p)) {
        enqueue(() => record(target.siteId, event, country, now));
      }

      ctx.set("Cache-Control", "no-store");
      ctx.status = 204;
    }
  );

  return router;
}

/**
 * Whether a view's start is inside the accepted window, [now - 24 h, now + 5
 * min], both ends included.
 *
 * @param startedAt the event's start, in epoch seconds.
 * @param now the server time, in epoch seconds.
 * @returns true when the event may be recorded.
 */
export function isStartInWindow(startedAt: number, now: number): boolean {
  return (
    startedAt >= now - PAST_WINDOW_SECONDS &&
    startedAt <= now + FUTURE_WINDOW_SECONDS
  );
}

/**
 * Drops the cached site lookup so the next event reloads it. For tests.
 */
export function clearIngestCache(): void {
  cache = undefined;
  loading = undefined;
  generation += 1;
}

/**
 * Waits for every event write that has been accepted so far. For tests.
 *
 * @returns a promise that resolves when the writes have finished.
 */
export async function flushIngestWrites(): Promise<void> {
  await Promise.all(pending);
}

/**
 * The Redis key counting a site's accepted events in the current window.
 *
 * @param siteId the site id.
 * @returns the key.
 */
export function siteCeilingKey(siteId: string): string {
  return `pages:ingest:site:${siteId}`;
}

let cache: { loadedAt: number; targets: Map<string, IngestTarget> } | undefined;
let loading: Promise<Map<string, IngestTarget>> | undefined;
let generation = 0;
const lastWarnedAt = new Map<string, number>();
const pending = new Set<Promise<void>>();

/**
 * Parses the raw body. The beacon sends JSON as text/plain to avoid a CORS
 * preflight; the global body parser leaves that as a string.
 */
function parseEvent(ctx: AppContext): PagesIngestEvent {
  if (ctx.request.length > MAX_BODY_BYTES) {
    ctx.throw(413);
  }

  const body: unknown = ctx.request.body;
  let json: unknown;
  if (ctx.is("text/plain")) {
    if (typeof body !== "string") {
      throw ValidationError(INVALID);
    }
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      ctx.throw(413);
    }
    try {
      json = JSON.parse(body);
    } catch {
      throw ValidationError(INVALID);
    }
  } else if (ctx.is("application/json")) {
    // Only reached without a Content-Length, e.g. a chunked body.
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) {
      ctx.throw(413);
    }
    json = body;
  } else {
    throw ValidationError(INVALID);
  }

  // A fixed message, so no submitted value is echoed or logged.
  const result = PagesIngestEventSchema.safeParse(json);
  if (!result.success) {
    throw ValidationError(INVALID);
  }
  return result.data;
}

/** Cloudflare's country header; XX is unknown and T1 is Tor. */
function countryOf(header: string): string | null {
  return /^[A-Z]{2}$/.test(header) && header !== "XX" && header !== "T1"
    ? header
    : null;
}

/**
 * Returns the ingest keys of every published site with measurement enabled,
 * with their page keys. The whole set is loaded at once, so a lookup never
 * depends on the key submitted: unknown keys add no cache entries and no
 * queries, and take the same time as known ones.
 */
async function lookup(): Promise<Map<string, IngestTarget>> {
  if (cache && Date.now() - cache.loadedAt < INGEST_CACHE_TTL_MS) {
    return cache.targets;
  }
  // Outside the request context: the shared load must not be cancelled
  // because the request that started it was closed by its client.
  loading ??= requestContext.exit(load).finally(() => {
    loading = undefined;
  });
  try {
    return await loading;
  } catch (err) {
    Logger.warn("Pages ingest lookup failed", {
      error: err instanceof Error ? err.name : "unknown",
    });
    return new Map();
  }
}

async function load(): Promise<Map<string, IngestTarget>> {
  // Taken before the query, so the data is never older than the TTL.
  const loadedAt = Date.now();
  const loadGeneration = generation;
  const publications = await PagesPublication.findAll({
    attributes: ["siteId", "pageKey"],
    include: [
      {
        model: PagesSite,
        as: "site",
        attributes: ["ingestKey"],
        required: true,
        where: {
          measurementEnabled: true,
          status: PagesSiteStatus.Published,
        },
      },
    ],
    order: [["siteId", "ASC"]],
    limit: MAX_CACHED_PAGES,
  });
  if (publications.length >= MAX_CACHED_PAGES) {
    Logger.warn("Pages ingest lookup is full; some pages are not measured");
  }

  const targets = new Map<string, IngestTarget>();
  for (const publication of publications) {
    const key = publication.site.ingestKey;
    const target = targets.get(key) ?? {
      siteId: publication.siteId,
      pageKeys: new Set<string>(),
    };
    target.pageKeys.add(publication.pageKey);
    targets.set(key, target);
  }
  if (loadGeneration === generation) {
    cache = { loadedAt, targets };
  }
  return targets;
}

/** Runs a write after the response; sheds load beyond the bound. */
function enqueue(write: () => Promise<void>): void {
  if (pending.size >= MAX_PENDING_WRITES) {
    return;
  }
  const promise: Promise<void> = requestContext
    .exit(write)
    .catch((err) => {
      // The error may carry the SQL bind values, so only its name is logged.
      Logger.warn("Pages ingest write failed", {
        error: err instanceof Error ? err.name : "unknown",
      });
    })
    .finally(() => {
      pending.delete(promise);
    });
  pending.add(promise);
}

/**
 * Counts an accepted event against the site's fixed one-minute window.
 * Fails closed: without Redis there is no bound, and losing measurement data
 * is harmless.
 */
async function underCeiling(siteId: string): Promise<boolean> {
  const key = siteCeilingKey(siteId);
  try {
    const results = await Redis.defaultClient
      .multi()
      .set(key, "0", "EX", 60, "NX")
      .incr(key)
      .exec();
    const [error, count] = results?.[1] ?? [];
    if (error) {
      throw error;
    }
    if (Number(count) > SITE_EVENTS_PER_MINUTE) {
      // Fixed text only: no ingest key, site id or other request value.
      warnThrottled("Pages ingest site ceiling reached; events are dropped");
      return false;
    }
    return true;
  } catch (err) {
    warnThrottled("Pages ingest ceiling unavailable", {
      error: err instanceof Error ? err.name : "unknown",
    });
    return false;
  }
}

/**
 * Logs a fixed message at most once a minute, however many events trigger it,
 * so an outage or a flood cannot flood the log.
 */
function warnThrottled(message: string, extra?: Record<string, string>): void {
  const now = Date.now();
  if (now - (lastWarnedAt.get(message) ?? -Infinity) < WARNING_INTERVAL_MS) {
    return;
  }
  lastWarnedAt.set(message, now);
  Logger.warn(message, extra);
}

/**
 * Upserts the view's row; replays and reordering can only raise it. An event
 * whose start is outside [now - 24 h, now + 5 min] is dropped: the start is
 * part of the row key, so replacing it would split one view into many rows.
 * A client clock more than 5 minutes fast, or a view older than 24 h, is
 * therefore not measured.
 */
async function record(
  siteId: string,
  event: PagesIngestEvent,
  country: string | null,
  nowMs: number
): Promise<void> {
  const now = Math.floor(nowMs / 1000);
  const startedAt = event.st;
  if (!isStartInWindow(startedAt, now)) {
    return;
  }
  if (!(await underCeiling(siteId))) {
    return;
  }

  const activeSeconds = Math.min(
    event.a,
    Math.max(0, now - startedAt) + ELAPSED_GRACE_SECONDS,
    MAX_ACTIVE_SECONDS
  );

  // Bind parameters, not replacements, so query logging never shows values.
  await sequelize.query(
    `INSERT INTO pages_view_events
       (id, "siteId", "pageKey", "sessionId", "startedAt", "lastSeenAt",
        "activeSeconds", "referrerDomain", country, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6, $6)
     ON CONFLICT ("siteId", "sessionId", "pageKey", "startedAt") DO UPDATE SET
       "activeSeconds" = GREATEST(pages_view_events."activeSeconds", EXCLUDED."activeSeconds"),
       "lastSeenAt" = GREATEST(pages_view_events."lastSeenAt", EXCLUDED."lastSeenAt"),
       "updatedAt" = EXCLUDED."updatedAt"`,
    {
      bind: [
        randomUUID(),
        siteId,
        event.p,
        event.s,
        new Date(startedAt * 1000),
        new Date(nowMs),
        activeSeconds,
        event.r ?? null,
        country,
      ],
      type: QueryTypes.INSERT,
    }
  );
}
