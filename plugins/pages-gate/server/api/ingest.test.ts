import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { randomString } from "@shared/random";
import env from "@server/env";
import Logger from "@server/logging/Logger";
import {
  PagesPublication,
  type PagesSite,
  PagesViewEvent,
} from "@server/models";
import { PagesSourceType } from "@server/models/PagesPublication";
import { PagesSiteStatus } from "@server/models/PagesSite";
import Redis from "@server/storage/redis";
import { buildUser } from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import { bundleToken, generateRawToken } from "@server/utils/csrf";
import RateLimiter from "@server/utils/RateLimiter";
import { buildBeaconScript } from "../lib/beacon";
import { runBeacon } from "../test/beaconHarness";
import { buildPagesSite } from "../test/factories";
import {
  INGEST_CACHE_TTL_MS,
  INGEST_RATE_LIMIT,
  SITE_EVENTS_PER_MINUTE,
  clearIngestCache,
  flushIngestWrites,
  isStartInWindow,
  siteCeilingKey,
} from "./ingest";

// The first request boots the app; under a parallel run it can pass 5s.
vi.setConfig({ testTimeout: 60_000 });

// Mounted here, before the API app is built by getTestServer(), exactly as
// index.ts does when the plugin is enabled.
await vi.hoisted(async () => {
  const { PluginManager, Hook } = await import("@server/utils/PluginManager");
  const { default: pages } = await import("./pages");
  PluginManager.add({ type: Hook.API, value: pages });
});

const server = getTestServer();

const IP = "203.0.113.77";
const USER_AGENT = "Mozilla/5.0 (UA-MARKER-q7Zt) ProbeBrowser/9.9";
const ROUTE = "/api/pages.ingest";

/** Every session id and ingest key used, checked against logs at the end. */
const secrets = new Set<string>([IP, USER_AGENT, "UA-MARKER-q7Zt"]);
const logCalls: unknown[][] = [];

beforeAll(() => {
  for (const method of ["debug", "info", "warn", "error", "silly"] as const) {
    vi.spyOn(Logger, method).mockImplementation((...args: unknown[]) => {
      logCalls.push(args);
    });
  }
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[method].bind(console);
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logCalls.push(args);
      original(...args);
    });
  }
});

afterAll(() => {
  const logged = logCalls.map((args) => inspect(args, { depth: 10 })).join();
  for (const secret of secrets) {
    expect(logged).not.toContain(secret);
  }
  vi.restoreAllMocks();
});

beforeEach(() => {
  clearIngestCache();
});

afterEach(async () => {
  await flushIngestWrites();
  vi.useRealTimers();
});

const nowSeconds = () => Math.floor(Date.now() / 1000);

const sessionId = () => {
  const id = randomString(20)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "a");
  secrets.add(id);
  return id;
};

async function publishedSite(overrides: Partial<PagesSite> = {}) {
  const site = await buildPagesSite({
    status: PagesSiteStatus.Published,
    measurementEnabled: true,
    ...overrides,
  });
  secrets.add(site.ingestKey);
  await publishPage(site, "index.html");
  clearIngestCache();
  return site;
}

async function publishPage(site: PagesSite, pageKey: string) {
  await PagesPublication.create({
    siteId: site.id,
    pageKey,
    sourceType: PagesSourceType.Document,
    sourceId: randomUUID(),
    contentHash: "0".repeat(64),
    objectKey: `${site.prefix}${pageKey}`,
    publishedAt: new Date(),
  });
}

function eventFor(site: PagesSite, overrides: Record<string, unknown> = {}) {
  return {
    k: site.ingestKey,
    p: "index.html",
    s: sessionId(),
    st: nowSeconds() - 120,
    t: "view",
    a: 0,
    ...overrides,
  };
}

async function send(
  body: unknown,
  options: { json?: boolean; headers?: Record<string, string> } = {}
) {
  const res = await server.post(ROUTE, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "Content-Type": options.json
        ? "application/json"
        : "text/plain;charset=UTF-8",
      ...options.headers,
    },
  });
  await flushIngestWrites();
  return res;
}

const rowsFor = (site: PagesSite) =>
  PagesViewEvent.findAll({
    where: { siteId: site.id },
    order: [["id", "ASC"]],
  });

describe("pages.ingest", () => {
  describe("accepted events", () => {
    it("accepts a text/plain body with 204, an empty body and no-store", async () => {
      const site = await publishedSite();
      const res = await send(eventFor(site));

      expect(res.status).toEqual(204);
      expect(await res.text()).toEqual("");
      expect(res.headers.get("cache-control")).toEqual("no-store");
      expect(await rowsFor(site)).toHaveLength(1);
    });

    it("accepts an application/json body", async () => {
      const site = await publishedSite();
      const res = await send(eventFor(site), { json: true });

      expect(res.status).toEqual(204);
      expect(await res.text()).toEqual("");
      expect(res.headers.get("cache-control")).toEqual("no-store");
      expect(await rowsFor(site)).toHaveLength(1);
    });

    it("folds view, beat and end into one row with the most active seconds", async () => {
      const site = await publishedSite();
      const event = eventFor(site, { st: nowSeconds() - 300 });

      await send({ ...event, t: "view", a: 0 });
      await send({ ...event, t: "beat", a: 15 });
      await send({ ...event, t: "beat", a: 30 });
      await send({ ...event, t: "end", a: 42 });

      const rows = await rowsFor(site);
      expect(rows).toHaveLength(1);
      expect(rows[0].activeSeconds).toEqual(42);
      expect(rows[0].pageKey).toEqual("index.html");
      expect(rows[0].sessionId).toEqual(event.s);
      expect(rows[0].startedAt.getTime()).toEqual(event.st * 1000);
    });

    it("leaves the same row for duplicate and out-of-order events", async () => {
      const site = await publishedSite();
      const event = eventFor(site, { st: nowSeconds() - 300 });

      await send({ ...event, t: "beat", a: 60 });
      await send({ ...event, t: "beat", a: 60 });
      await send({ ...event, t: "view", a: 0 });
      await send({ ...event, t: "beat", a: 30 });

      const rows = await rowsFor(site);
      expect(rows).toHaveLength(1);
      expect(rows[0].activeSeconds).toEqual(60);
    });

    it("keeps separate rows for different sessions and pages", async () => {
      const site = await publishedSite();
      await publishPage(site, "about.html");
      clearIngestCache();
      const st = nowSeconds() - 60;

      await send(eventFor(site, { st }));
      await send(eventFor(site, { st }));
      await send(eventFor(site, { st, p: "about.html" }));

      expect(await rowsFor(site)).toHaveLength(3);
    });
  });

  describe("silent drops", () => {
    it("drops an unknown ingest key with 204 and no write", async () => {
      const site = await publishedSite();
      const where = { siteId: site.id };
      const before = await PagesViewEvent.count({ where });

      const res = await send(eventFor(site, { k: randomString(32) }));

      expect(res.status).toEqual(204);
      expect(await res.text()).toEqual("");
      expect(res.headers.get("cache-control")).toEqual("no-store");
      expect(await PagesViewEvent.count({ where })).toEqual(before);
    });

    it.each([
      ["measurement is disabled", { measurementEnabled: false }],
      ["the site is a draft", { status: PagesSiteStatus.Draft }],
      ["the site is unpublished", { status: PagesSiteStatus.Unpublished }],
    ])("drops an event when %s", async (_label, overrides) => {
      const site = await publishedSite(overrides);

      const res = await send(eventFor(site));

      expect(res.status).toEqual(204);
      expect(await res.text()).toEqual("");
      expect(await rowsFor(site)).toHaveLength(0);
    });

    it("drops a page key that is not published in the site", async () => {
      const site = await publishedSite();

      const res = await send(eventFor(site, { p: "missing.html" }));

      expect(res.status).toEqual(204);
      expect(await rowsFor(site)).toHaveLength(0);
    });

    it("answers identically for an existing and an unknown ingest key", async () => {
      const site = await publishedSite();
      const known = await send(eventFor(site));
      const unknown = await send(eventFor(site, { k: randomString(32) }));

      expect(unknown.status).toEqual(known.status);
      expect(await unknown.text()).toEqual(await known.text());
      const headers = (res: typeof known) =>
        [...res.headers.keys()].filter((h) => h !== "date").sort();
      expect(headers(unknown)).toEqual(headers(known));
    });
  });

  describe("validation", () => {
    it("refuses invalid JSON with 400", async () => {
      const site = await publishedSite();
      const res = await send("{not json");
      expect(res.status).toEqual(400);
      expect(await rowsFor(site)).toHaveLength(0);
    });

    it("refuses a body that is not a JSON object with 400", async () => {
      expect((await send("[]")).status).toEqual(400);
      expect((await send('"view"')).status).toEqual(400);
      expect((await send("")).status).toEqual(400);
    });

    it("refuses other content types with 400", async () => {
      const res = await server.post(ROUTE, {
        body: "k=abc",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      expect(res.status).toEqual(400);
    });

    it.each([
      ["a short ingest key", { k: "short" }],
      ["an ingest key with symbols", { k: `${"a".repeat(22)}!` }],
      ["an ingest key that is too long", { k: "a".repeat(65) }],
      ["a page key outside the site", { p: "../secret.html" }],
      ["an absolute page key", { p: "/index.html" }],
      ["an uppercase session id", { s: "ABCDEFGHIJKLMNOP" }],
      ["a short session id", { s: "abc" }],
      ["a non-integer start", { st: 1.5 }],
      ["a string start", { st: "1700000000" }],
      ["an unknown event type", { t: "click" }],
      ["negative active seconds", { a: -1 }],
      ["too many active seconds", { a: 28801 }],
      ["string active seconds", { a: "5" }],
      ["a missing field", { t: undefined }],
      ["a referrer URL", { r: "https://example.com/path" }],
      ["a referrer with a port", { r: "example.com:8080" }],
      ["a referrer with userinfo", { r: "user@example.com" }],
      ["an uppercase referrer", { r: "Example.com" }],
      ["an IP referrer", { r: "203.0.113.9" }],
      ["a non-string referrer", { r: 5 }],
    ])("refuses %s with 400", async (_label, overrides) => {
      const site = await publishedSite();
      const res = await send(eventFor(site, overrides));

      expect(res.status).toEqual(400);
      // The message never echoes the submitted values.
      const body = await res.json();
      expect(body.message).toEqual("Invalid event");
      expect(await rowsFor(site)).toHaveLength(0);
    });

    it("refuses a body over 1 KiB with 413", async () => {
      const site = await publishedSite();
      const padded = eventFor(site, { pad: "x".repeat(1024) });

      expect((await send(padded)).status).toEqual(413);
      expect((await send(padded, { json: true })).status).toEqual(413);
      expect(await rowsFor(site)).toHaveLength(0);
    });

    it("ignores and never persists unknown fields", async () => {
      const site = await publishedSite();
      const other = await publishedSite();
      const id = randomUUID();
      const event = eventFor(site, {
        id,
        siteId: other.id,
        activeSeconds: 999,
        country: "US",
        referrerDomain: "evil.example.com",
        createdAt: "2001-01-01T00:00:00Z",
      });

      const res = await send(event);

      expect(res.status).toEqual(204);
      const rows = await rowsFor(site);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).not.toEqual(id);
      expect(rows[0].activeSeconds).toEqual(0);
      expect(rows[0].country).toBeNull();
      expect(rows[0].referrerDomain).toBeNull();
      expect(rows[0].createdAt.getFullYear()).not.toEqual(2001);
      expect(await rowsFor(other)).toHaveLength(0);
    });
  });

  describe("clamping", () => {
    it("accepts a start from 24 h ago to 5 min ahead, both ends included", () => {
      const now = 1_900_000_000;
      expect(isStartInWindow(now - 24 * 3600, now)).toBe(true);
      expect(isStartInWindow(now - 24 * 3600 - 1, now)).toBe(false);
      expect(isStartInWindow(now + 300, now)).toBe(true);
      expect(isStartInWindow(now + 301, now)).toBe(false);
      expect(isStartInWindow(now, now)).toBe(true);
    });

    // Through the route, with margins that a second boundary cannot flip; the
    // exact edges are covered by the pure test above.
    it.each([
      ["25 hours ago", -25 * 3600],
      ["360 seconds ahead", 360],
    ])(
      "drops a start %s with no row and no counter",
      async (_label, offset) => {
        const site = await publishedSite();
        const res = await send(eventFor(site, { st: nowSeconds() + offset }));

        expect(res.status).toEqual(204);
        expect(await rowsFor(site)).toHaveLength(0);
        expect(
          await Redis.defaultClient.get(siteCeilingKey(site.id))
        ).toBeNull();
      }
    );

    it.each([
      ["23 hours ago", -23 * 3600],
      ["240 seconds ahead", 240],
    ])("accepts a start %s as sent", async (_label, offset) => {
      const site = await publishedSite();
      const st = nowSeconds() + offset;
      await send(eventFor(site, { st }));

      const rows = await rowsFor(site);
      expect(rows).toHaveLength(1);
      expect(rows[0].startedAt.getTime()).toEqual(st * 1000);
    });

    it("keeps one row for a client 4 minutes fast", async () => {
      const site = await publishedSite();
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
      const event = eventFor(site, { st: nowSeconds() + 240 });
      const seen: number[] = [];

      for (let beat = 0; beat < 20; beat++) {
        await send({ ...event, t: beat ? "beat" : "view", a: beat * 15 });
        const rows = await rowsFor(site);
        expect(rows).toHaveLength(1);
        seen.push(rows[0].activeSeconds);
        vi.setSystemTime(Date.now() + 15_000);
      }

      expect(seen).toEqual([...seen].sort((x, y) => x - y));
      expect(seen[seen.length - 1]).toBeGreaterThan(0);
    });

    it("clamps active seconds to the elapsed time plus 30", async () => {
      const site = await publishedSite();
      const st = nowSeconds() - 10;
      await send(eventFor(site, { st, t: "beat", a: 1000 }));

      const [row] = await rowsFor(site);
      expect(row.activeSeconds).toBeGreaterThanOrEqual(40);
      expect(row.activeSeconds).toBeLessThanOrEqual(42);
    });

    it("never decreases a row", async () => {
      const site = await publishedSite();
      const event = eventFor(site, { st: nowSeconds() - 600 });
      await send({ ...event, t: "beat", a: 300 });
      await send({ ...event, t: "end", a: 10 });

      const [row] = await rowsFor(site);
      expect(row.activeSeconds).toEqual(300);
    });
  });

  describe("privacy", () => {
    it("stores no IP address, user agent or cookie in any column", async () => {
      const site = await publishedSite();
      const event = eventFor(site, { r: "news.example.com" });
      const headers = {
        "X-Forwarded-For": IP,
        "X-Real-IP": IP,
        "User-Agent": USER_AGENT,
        Cookie: `tracker=${IP}; ua=UA-MARKER-q7Zt`,
        "CF-IPCountry": "DE",
      };

      await send({ ...event, t: "view" }, { headers });
      await send({ ...event, t: "beat", a: 15 }, { headers, json: true });

      const rows = await PagesViewEvent.findAll({
        where: { siteId: site.id },
        raw: true,
      });
      expect(rows).toHaveLength(1);
      for (const row of rows) {
        for (const value of Object.values(row)) {
          const text = String(
            value instanceof Date ? value.toISOString() : value
          );
          expect(text).not.toContain(IP);
          expect(text).not.toContain("UA-MARKER-q7Zt");
        }
      }
      expect(rows[0].referrerDomain).toEqual("news.example.com");
      expect(rows[0].country).toEqual("DE");
    });

    it.each([
      ["XX", null],
      ["T1", null],
      ["de", null],
      ["DEU", null],
      ["", null],
      ["FR", "FR"],
    ])("stores country %j as %j", async (header, expected) => {
      const site = await publishedSite();
      await send(eventFor(site), {
        headers: header ? { "CF-IPCountry": header } : {},
      });

      const [row] = await rowsFor(site);
      expect(row.country).toEqual(expected);
    });

    it("keeps the first referrer and country of a view", async () => {
      const site = await publishedSite();
      const event = eventFor(site);
      await send(
        { ...event, r: "first.example.com" },
        { headers: { "CF-IPCountry": "DE" } }
      );
      await send(
        { ...event, t: "beat", a: 15, r: "second.example.com" },
        { headers: { "CF-IPCountry": "FR" } }
      );

      const [row] = await rowsFor(site);
      expect(row.referrerDomain).toEqual("first.example.com");
      expect(row.country).toEqual("DE");
    });
  });

  describe("authentication", () => {
    it("needs no authorization, cookie or CSRF token and sets no cookie", async () => {
      const site = await publishedSite();
      const res = await send(eventFor(site));

      expect(res.status).toEqual(204);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await rowsFor(site)).toHaveLength(1);
    });

    it("ignores unrelated cookies", async () => {
      const site = await publishedSite();
      const res = await send(eventFor(site), {
        headers: { Cookie: "foo=bar; theme=dark" },
      });

      expect(res.status).toEqual(204);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await rowsFor(site)).toHaveLength(1);
    });

    it("behaves the same with a valid session cookie and sets no cookie", async () => {
      const site = await publishedSite();
      const user = await buildUser();
      const csrf = bundleToken(generateRawToken(16), env.SECRET_KEY);
      const res = await send(eventFor(site), {
        headers: {
          Cookie: `accessToken=${user.getSessionToken()}; csrfToken=${csrf}`,
          "x-csrf-token": csrf,
        },
      });

      expect(res.status).toEqual(204);
      expect(await res.text()).toEqual("");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await rowsFor(site)).toHaveLength(1);
    });

    // The API's global CSRF guard runs before every plugin route and refuses
    // a cookie-authenticated POST without a token. The beacon must therefore
    // send with credentials omitted; this pins the behaviour so a change to
    // the guard is noticed.
    it("is refused by the global CSRF guard for a session cookie without a token", async () => {
      const site = await publishedSite();
      const user = await buildUser();
      const res = await send(eventFor(site), {
        headers: { Cookie: `accessToken=${user.getSessionToken()}` },
      });

      expect(res.status).toEqual(403);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await rowsFor(site)).toHaveLength(0);
    });
  });

  describe("abuse bounds", () => {
    it("is rate limited per client with the ingest strategy", async () => {
      const enabled = env.RATE_LIMITER_ENABLED;
      const multiplier = env.RATE_LIMITER_MULTIPLIER;
      env.RATE_LIMITER_ENABLED = true;
      env.RATE_LIMITER_MULTIPLIER = 1;
      try {
        const site = await publishedSite();
        const res = await send(eventFor(site));
        expect(res.status).toEqual(204);
        const path = RateLimiter.normalizePath(ROUTE);
        expect(RateLimiter.hasRateLimiter(path)).toBe(true);
        expect(RateLimiter.getRateLimiter(path).points).toEqual(
          INGEST_RATE_LIMIT.requests
        );
        expect(RateLimiter.getRateLimiter(path).duration).toEqual(
          INGEST_RATE_LIMIT.duration
        );
      } finally {
        env.RATE_LIMITER_ENABLED = enabled;
        env.RATE_LIMITER_MULTIPLIER = multiplier;
      }
    });

    it("counts accepted events against the site ceiling", async () => {
      const site = await publishedSite();
      await send(eventFor(site));
      await send(eventFor(site));

      expect(await Redis.defaultClient.get(siteCeilingKey(site.id))).toEqual(
        "2"
      );
      expect(
        await Redis.defaultClient.ttl(siteCeilingKey(site.id))
      ).toBeGreaterThan(0);
    });

    it("drops events over the site ceiling with 204 and no write", async () => {
      const site = await publishedSite();
      await Redis.defaultClient.set(
        siteCeilingKey(site.id),
        String(SITE_EVENTS_PER_MINUTE),
        "EX",
        60
      );

      const res = await send(eventFor(site));

      expect(res.status).toEqual(204);
      expect(await res.text()).toEqual("");
      expect(await rowsFor(site)).toHaveLength(0);
    });

    it("logs a saturated site ceiling once a minute with no request values", async () => {
      const site = await publishedSite();
      // Past any earlier warning, so the throttle window starts fresh.
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 7_200_000 });
      // Deleted first: after the fake clock moves, the Redis mock reads a key
      // set over an expired one as already expired.
      const saturate = async () => {
        await Redis.defaultClient.del(siteCeilingKey(site.id));
        await Redis.defaultClient.set(
          siteCeilingKey(site.id),
          String(SITE_EVENTS_PER_MINUTE),
          "EX",
          60
        );
      };
      await saturate();
      const mark = logCalls.length;

      for (let i = 0; i < 20; i++) {
        expect((await send(eventFor(site))).status).toEqual(204);
      }
      const saturated = (args: unknown[]) =>
        args[0] === "Pages ingest site ceiling reached; events are dropped";
      expect(logCalls.slice(mark).filter(saturated)).toHaveLength(1);

      // A minute later the window has rolled over; saturate it again.
      vi.setSystemTime(Date.now() + 61_000);
      await saturate();
      await send(eventFor(site));
      const logged = logCalls.slice(mark).filter(saturated);
      expect(logged).toHaveLength(2);
      for (const args of logged) {
        expect(args.slice(1).filter((arg) => arg !== undefined)).toEqual([]);
      }
      expect(await rowsFor(site)).toHaveLength(0);
    });

    it("creates no counter for dropped events", async () => {
      const site = await publishedSite({ measurementEnabled: false });
      await send(eventFor(site));

      expect(await Redis.defaultClient.get(siteCeilingKey(site.id))).toBeNull();
    });

    it("writes one row for 20 simultaneous beats of a new view", async () => {
      const site = await publishedSite();
      const event = eventFor(site, { t: "beat" });

      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          server.post(ROUTE, {
            body: JSON.stringify({ ...event, a: i }),
            headers: { "Content-Type": "text/plain" },
          })
        )
      );
      await flushIngestWrites();

      expect(responses.map((res) => res.status)).toEqual(
        Array.from({ length: 20 }, () => 204)
      );
      const rows = await rowsFor(site);
      expect(rows).toHaveLength(1);
      expect(rows[0].activeSeconds).toEqual(19);
    });
  });

  describe("lookup cache", () => {
    it("stops accepting within the TTL after measurement is disabled", async () => {
      const site = await publishedSite();
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
      await send(eventFor(site));

      await site.update({ measurementEnabled: false });
      await send(eventFor(site));
      expect(await rowsFor(site)).toHaveLength(2);

      vi.setSystemTime(Date.now() + INGEST_CACHE_TTL_MS + 1);
      await send(eventFor(site));
      expect(await rowsFor(site)).toHaveLength(2);
    });

    it("stops accepting within the TTL after the site is unpublished", async () => {
      const site = await publishedSite();
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
      await send(eventFor(site));

      await site.update({ status: PagesSiteStatus.Unpublished });
      vi.setSystemTime(Date.now() + INGEST_CACHE_TTL_MS + 1);
      await send(eventFor(site));
      expect(await rowsFor(site)).toHaveLength(1);
    });

    it("fails closed and logs at most once a minute when Redis fails", async () => {
      const site = await publishedSite();
      // Past any earlier warning, so the throttle window starts fresh.
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3_600_000 });
      const events = Array.from({ length: 50 }, () => eventFor(site));
      const multi = vi
        .spyOn(Redis.defaultClient, "multi")
        .mockImplementation(() => {
          throw new Error(`redis down for ${events[0].s} ${site.ingestKey}`);
        });
      const mark = logCalls.length;
      try {
        for (const event of events) {
          const res = await send(event);
          expect(res.status).toEqual(204);
        }
      } finally {
        multi.mockRestore();
      }

      const logged = logCalls.slice(mark);
      expect(logged).toHaveLength(1);
      expect(logged[0][0]).toEqual("Pages ingest ceiling unavailable");
      expect(await rowsFor(site)).toHaveLength(0);

      // Healthy again: accepted as before.
      await send(eventFor(site));
      expect(await rowsFor(site)).toHaveLength(1);
    });

    it("bounds the TTL between 30 and 60 seconds", () => {
      expect(INGEST_CACHE_TTL_MS).toBeGreaterThanOrEqual(30_000);
      expect(INGEST_CACHE_TTL_MS).toBeLessThanOrEqual(60_000);
    });
  });
});

describe("bodies from the beacon script", () => {
  it("are accepted and merged into one row with the beacon's active time", async () => {
    const site = await publishedSite();
    const run = runBeacon(
      buildBeaconScript({
        endpoint: `${env.URL}${ROUTE}`,
        ingestKey: site.ingestKey,
        pageKey: "index.html",
      }),
      { now: Date.now(), referrer: "https://news.ycombinator.com/item?id=1" }
    );
    run.interact();
    run.advance(15_000);
    run.interact();
    run.advance(5_000);
    run.setVisibility("hidden");
    run.close();

    const bodies = run.rawBodies();
    expect(run.bodies().map((b) => b.t)).toEqual(["view", "beat", "end"]);
    secrets.add(String(run.bodies()[0].s));
    for (const body of bodies) {
      const res = await send(body);
      expect(res.status).toEqual(204);
    }

    const rows = await rowsFor(site);
    expect(rows).toHaveLength(1);
    expect(rows[0].activeSeconds).toEqual(20);
    expect(rows[0].referrerDomain).toEqual("news.ycombinator.com");
    expect(rows[0].sessionId).toEqual(run.bodies()[0].s);
  });
});
