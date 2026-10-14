import { PagesInsight, PagesPublication } from "@server/models";
import { PagesSourceType } from "@server/models/PagesPublication";
import { PagesInsightPeriod } from "@server/models/PagesInsight";
import {
  buildAdmin,
  buildApiKey,
  buildGuestUser,
  buildTeam,
  buildUser,
  buildViewer,
} from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import pagesEnv from "../env";
import RollupPagesInsightsTask from "../tasks/RollupPagesInsightsTask";
import { buildPagesSite, buildPagesViewEvent } from "../test/factories";

// See pages.test.ts: the plugin registers nothing under test, so mount the
// router before the API app is built.
await vi.hoisted(async () => {
  const { PluginManager, Hook } = await import("@server/utils/PluginManager");
  const { default: pages } = await import("./pages");
  PluginManager.add({ type: Hook.API, value: pages });
});

vi.setConfig({ testTimeout: 30000 });

const server = getTestServer();

// A far-future Wednesday: cleanup tests elsewhere delete only events older
// than the retention window, so these are never removed under them. A
// different year from RollupPagesInsightsTask.test.ts (2037), since the
// rollup here runs for every site and must not recompute its dates.
// Current UTC week starts Monday 2065-10-12, previous 2065-10-05.
const NOW = new Date("2065-10-14T12:00:00Z");

const props = {
  limit: 10000,
  partition: { partitionIndex: 0, partitionCount: 1 },
};

async function setup() {
  const team = await buildTeam();
  const admin = await buildAdmin({ teamId: team.id });
  const site = await buildPagesSite({ teamId: team.id, createdById: admin.id });
  return { team, admin, site };
}

async function event(
  siteId: string,
  pageKey: string,
  sessionId: string,
  startedAt: string,
  activeSeconds: number
) {
  return buildPagesViewEvent({
    siteId,
    pageKey,
    sessionId: `${sessionId}${"x".repeat(16)}`.slice(0, 16),
    startedAt: new Date(startedAt),
    activeSeconds,
  });
}

/** Hand-computed fixture, see the expectations in the tests below. */
async function seedFixture(siteId: string) {
  // The two stored days are written by the real rollup, run on Oct 10.
  await event(siteId, "/a", "s1", "2065-10-09T09:00:00Z", 8);
  await event(siteId, "/a", "s2", "2065-10-09T10:00:00Z", 25);
  await event(siteId, "/a", "s1", "2065-10-09T11:00:00Z", 70);
  await event(siteId, "/b", "s3", "2065-10-09T12:00:00Z", 40);
  await event(siteId, "/a", "s1", "2065-10-10T09:00:00Z", 12);
  await event(siteId, "/b", "s2", "2065-10-10T10:00:00Z", 50);
  vi.setSystemTime(new Date("2065-10-10T23:00:00Z"));
  await new RollupPagesInsightsTask().perform(props);
  vi.setSystemTime(NOW);
  // Never rolled up before the requests: served live.
  await event(siteId, "/a", "s1", "2065-10-13T09:00:00Z", 20);
  await event(siteId, "/a", "s4", "2065-10-13T10:00:00Z", 5);
  await event(siteId, "/b", "s5", "2065-10-14T09:00:00Z", 700);
  await event(siteId, "/a", "s1", "2065-10-14T10:00:00Z", 0);
}

async function insights(
  user: Parameters<typeof server.post>[1],
  body: Record<string, unknown>
) {
  const res = await server.post("/api/pages.insights", user, { body });
  return { res, body: await res.json() };
}

describe("#pages.insights", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("access", () => {
    it("refuses an unauthenticated request with 401", async () => {
      const { site } = await setup();
      const res = await server.post("/api/pages.insights", {
        body: { id: site.id },
      });
      expect(res.status).toEqual(401);
    });

    it.each([
      ["member", buildUser],
      ["viewer", buildViewer],
      ["guest", buildGuestUser],
    ])("refuses a %s with 403", async (_role, build) => {
      const { team, site } = await setup();
      const user = await build({ teamId: team.id });
      const { res } = await insights(user, { id: site.id });
      expect(res.status).toEqual(403);
    });

    it("allows an admin and sets no-store", async () => {
      const { admin, site } = await setup();
      const { res } = await insights(admin, { id: site.id });
      expect(res.status).toEqual(200);
      expect(res.headers.get("cache-control")).toEqual("no-store");
    });

    it("allows a platform admin without the admin role", async () => {
      const { team, site } = await setup();
      const platformAdmin = await buildUser({
        teamId: team.id,
        flags: { platformAdmin: 1 },
      });
      const { res } = await insights(platformAdmin, { id: site.id });
      expect(res.status).toEqual(200);
    });

    it("returns 404 to another team's admin and platform admin", async () => {
      const { site } = await setup();
      const outsider = await buildAdmin();
      const platformOutsider = await buildUser({
        flags: { platformAdmin: 1 },
      });
      expect((await insights(outsider, { id: site.id })).res.status).toEqual(
        404
      );
      expect(
        (await insights(platformOutsider, { id: site.id })).res.status
      ).toEqual(404);
    });

    it("refuses an admin's API key", async () => {
      const { admin, site } = await setup();
      const apiKey = await buildApiKey({ userId: admin.id });
      const res = await server.post("/api/pages.insights", {
        body: { id: site.id },
        headers: { Authorization: `Bearer ${apiKey.value}` },
      });
      expect(res.status).toEqual(403);
    });
  });

  describe("validation", () => {
    it.each([
      [{ id: "nope" }],
      [{ period: "month" }],
      [{ days: 8 }],
      [{ days: 365 }],
      [{ days: "30" }],
      [{ days: 0 }],
    ])("rejects %j with 400", async (extra) => {
      const { admin, site } = await setup();
      const { res } = await insights(admin, { id: site.id, ...extra });
      expect(res.status).toEqual(400);
    });

    it("defaults to 30 days by day and reports the retention", async () => {
      const { admin, site } = await setup();
      const { body } = await insights(admin, { id: site.id });
      expect(body.data.period).toEqual("day");
      expect(body.data.series).toHaveLength(30);
      expect(body.data.from).toEqual("2065-09-15");
      expect(body.data.to).toEqual("2065-10-14");
      expect(body.data.retentionDays).toEqual(
        pagesEnv.PAGES_EVENT_RETENTION_DAYS
      );
      expect(body.data.totals).toEqual({
        views: 0,
        visitors: 0,
        visitorsApproximate: false,
        activeSeconds: 0,
        averageSeconds: 0,
        medianSeconds: 0,
        medianApproximate: true,
      });
      expect(body.data.pages).toEqual([]);
    });
  });

  describe("results", () => {
    it("computes totals, a zero-filled series and top pages by day", async () => {
      const { admin, site } = await setup();
      await seedFixture(site.id);
      // "/a" has a stored title; "/b" has no publication row and shows its key.
      await PagesPublication.create({
        siteId: site.id,
        pageKey: "/a",
        title: "Alpha guide",
        sourceType: PagesSourceType.Document,
        sourceId: site.id,
        contentHash: "0".repeat(64),
        objectKey: `${site.prefix}a`,
        publishedAt: new Date(),
      });

      const { res, body } = await insights(admin, {
        id: site.id,
        period: "day",
        days: 7,
      });

      expect(res.status).toEqual(200);
      expect(body.data.from).toEqual("2065-10-08");
      expect(body.data.to).toEqual("2065-10-14");
      expect(body.data.series).toEqual([
        { date: "2065-10-08", views: 0, visitors: 0, activeSeconds: 0 },
        { date: "2065-10-09", views: 4, visitors: 3, activeSeconds: 143 },
        { date: "2065-10-10", views: 2, visitors: 2, activeSeconds: 62 },
        { date: "2065-10-11", views: 0, visitors: 0, activeSeconds: 0 },
        { date: "2065-10-12", views: 0, visitors: 0, activeSeconds: 0 },
        { date: "2065-10-13", views: 2, visitors: 2, activeSeconds: 25 },
        { date: "2065-10-14", views: 2, visitors: 2, activeSeconds: 700 },
      ]);
      // 10 views, 930 seconds. Distinct sessions s1..s5 = 5 (the daily
      // values sum to 9). Histogram 0-9:3 10-29:3 30-59:2 60-179:1 600+:1:
      // rank 5 is 2/3 into 10-29: 10 + 2/3 * 20 = 23.33.
      expect(body.data.totals).toEqual({
        views: 10,
        visitors: 5,
        visitorsApproximate: false,
        activeSeconds: 930,
        averageSeconds: 93,
        medianSeconds: 23,
        medianApproximate: true,
      });
      expect(body.data.pages).toEqual([
        {
          pageKey: "/a",
          title: "Alpha guide",
          views: 7,
          visitors: 3,
          averageSeconds: 20,
        },
        {
          pageKey: "/b",
          title: "/b",
          views: 3,
          visitors: 3,
          averageSeconds: 263,
        },
      ]);
    });

    it("groups by Monday week and rounds days up to whole weeks", async () => {
      const { admin, site } = await setup();
      await seedFixture(site.id);

      const { body } = await insights(admin, {
        id: site.id,
        period: "week",
        days: 30,
      });

      expect(body.data.from).toEqual("2065-09-14");
      expect(body.data.series).toEqual([
        { date: "2065-09-14", views: 0, visitors: 0, activeSeconds: 0 },
        { date: "2065-09-21", views: 0, visitors: 0, activeSeconds: 0 },
        { date: "2065-09-28", views: 0, visitors: 0, activeSeconds: 0 },
        { date: "2065-10-05", views: 6, visitors: 3, activeSeconds: 205 },
        { date: "2065-10-12", views: 4, visitors: 3, activeSeconds: 725 },
      ]);
      expect(body.data.totals.views).toEqual(10);
      expect(body.data.totals.visitors).toEqual(5);
      expect(body.data.totals.medianSeconds).toEqual(23);
    });

    it("splits weeks at Monday 00:00 UTC", async () => {
      const { admin, site } = await setup();
      await event(site.id, "/a", "s1", "2065-10-11T23:59:59Z", 1);
      await event(site.id, "/a", "s2", "2065-10-12T00:00:00Z", 1);

      const { body } = await insights(admin, {
        id: site.id,
        period: "week",
        days: 7,
      });
      expect(body.data.series).toEqual([
        { date: "2065-10-12", views: 1, visitors: 1, activeSeconds: 1 },
      ]);
      const previous = await insights(admin, {
        id: site.id,
        period: "week",
        days: 30,
      });
      expect(previous.body.data.series.slice(-2)).toEqual([
        { date: "2065-10-05", views: 1, visitors: 1, activeSeconds: 1 },
        { date: "2065-10-12", views: 1, visitors: 1, activeSeconds: 1 },
      ]);
    });

    it("shows an event created after the last rollup and never doubles it", async () => {
      const { admin, site } = await setup();
      await event(site.id, "/a", "s1", "2065-10-14T09:00:00Z", 30);
      vi.setSystemTime(new Date("2065-10-14T09:30:00Z"));
      await new RollupPagesInsightsTask().perform(props);
      vi.setSystemTime(NOW);
      // Rollup rows exist for today now; this event is newer than them.
      await event(site.id, "/a", "s2", "2065-10-14T11:00:00Z", 10);

      const first = await insights(admin, { id: site.id, days: 7 });
      expect(first.body.data.totals).toMatchObject({
        views: 2,
        visitors: 2,
        activeSeconds: 40,
      });

      await new RollupPagesInsightsTask().perform(props);
      const stored = await PagesInsight.findOne({
        where: {
          siteId: site.id,
          pageKey: "",
          date: "2065-10-14",
          period: PagesInsightPeriod.Day,
        },
      });
      expect(stored?.viewCount).toEqual(2);

      const second = await insights(admin, { id: site.id, days: 7 });
      expect(second.body.data).toEqual(first.body.data);

      const week = await insights(admin, { id: site.id, period: "week" });
      expect(week.body.data.totals).toMatchObject({ views: 2, visitors: 2 });
    });

    it("reads unsettled periods from events, not from their stored rows", async () => {
      const { admin, site } = await setup();
      await event(site.id, "/a", "s1", "2065-10-14T09:00:00Z", 30);
      // A stale rollup row for today that must not be added on top.
      await PagesInsight.create({
        siteId: site.id,
        pageKey: "",
        date: "2065-10-14",
        period: PagesInsightPeriod.Day,
        viewCount: 999,
        visitorCount: 999,
        totalActiveSeconds: 9999,
        timeHistogram: { "600+": 999 },
      });
      await PagesInsight.create({
        siteId: site.id,
        pageKey: "/a",
        date: "2065-10-14",
        period: PagesInsightPeriod.Day,
        viewCount: 999,
        visitorCount: 999,
        totalActiveSeconds: 9999,
        timeHistogram: {},
      });

      const { body } = await insights(admin, { id: site.id, days: 7 });
      expect(body.data.totals.views).toEqual(1);
      expect(body.data.series.at(-1)).toEqual({
        date: "2065-10-14",
        views: 1,
        visitors: 1,
        activeSeconds: 30,
      });
      expect(body.data.pages).toEqual([
        {
          pageKey: "/a",
          title: "/a",
          views: 1,
          visitors: 1,
          averageSeconds: 30,
        },
      ]);
    });

    it("falls back to summed visitors beyond raw retention", async () => {
      const { admin, site } = await setup();
      // Stored history only: 2065-09-20, 24 days before now.
      for (const [pageKey, views, visitors] of [
        ["", 5, 4],
        ["/a", 5, 4],
      ] as const) {
        await PagesInsight.create({
          siteId: site.id,
          pageKey,
          date: "2065-09-20",
          period: PagesInsightPeriod.Day,
          viewCount: views,
          visitorCount: visitors,
          totalActiveSeconds: 50,
          timeHistogram: { "10-29": 5 },
        });
      }
      await event(site.id, "/a", "s1", "2065-10-14T09:00:00Z", 10);

      const spy = vi
        .spyOn(pagesEnv, "PAGES_EVENT_RETENTION_DAYS", "get")
        .mockReturnValue(14);
      try {
        const { body } = await insights(admin, { id: site.id, days: 30 });
        expect(body.data.retentionDays).toEqual(14);
        expect(body.data.totals).toMatchObject({
          views: 6,
          visitors: 5,
          visitorsApproximate: true,
          activeSeconds: 60,
          medianApproximate: true,
        });
        expect(body.data.pages[0]).toEqual({
          pageKey: "/a",
          title: "/a",
          views: 6,
          visitors: 5,
          averageSeconds: 10,
        });
      } finally {
        spy.mockRestore();
      }
    });

    it("still returns history when measurement is off", async () => {
      const { admin, site } = await setup();
      await seedFixture(site.id);
      expect(site.measurementEnabled).toEqual(false);

      const { body } = await insights(admin, { id: site.id, days: 7 });
      expect(body.data.measurementEnabled).toEqual(false);
      expect(body.data.totals.views).toEqual(10);

      await site.update({ measurementEnabled: true });
      const on = await insights(admin, { id: site.id, days: 7 });
      expect(on.body.data.measurementEnabled).toEqual(true);
    });

    it("never returns another site's data", async () => {
      const { admin, site } = await setup();
      const other = await buildPagesSite({
        teamId: site.teamId,
        createdById: admin.id,
      });
      await event(other.id, "/a", "s1", "2065-10-14T09:00:00Z", 10);

      const { body } = await insights(admin, { id: site.id, days: 7 });
      expect(body.data.totals.views).toEqual(0);
      expect(body.data.pages).toEqual([]);
    });

    it("exposes no ingest key, session id or person", async () => {
      const { admin, site } = await setup();
      await seedFixture(site.id);
      const withKey = await site.reload();

      const { body } = await insights(admin, { id: site.id, days: 90 });
      const text = JSON.stringify(body);

      expect(withKey.ingestKey.length).toBeGreaterThan(10);
      expect(text).not.toContain(withKey.ingestKey);
      expect(text).not.toMatch(/ingestKey|sessionId|referrer|country|userId/i);
      expect(text).not.toContain("s1xxxxxxxxxxxxxx");
    });
  });
});

async function stored(
  siteId: string,
  date: string,
  pageKey: string,
  period: PagesInsightPeriod,
  viewCount: number,
  visitorCount: number,
  totalActiveSeconds: number,
  timeHistogram: Record<string, number>
) {
  return PagesInsight.create({
    siteId,
    pageKey,
    date,
    period,
    viewCount,
    visitorCount,
    totalActiveSeconds,
    timeHistogram,
  });
}

describe("#pages.insights rollup gaps and stored weeks", () => {
  const D = PagesInsightPeriod.Day;
  const W = PagesInsightPeriod.Week;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const point = (series: { date: string }[], date: string) =>
    series.find((p) => p.date === date);

  it("computes a settled day with events but no stored row from raw events", async () => {
    const { admin, site } = await setup();
    // 2065-10-10 is four days before today, settled, and never rolled up.
    await event(site.id, "/a", "s1", "2065-10-10T09:00:00Z", 10);
    await event(site.id, "/a", "s2", "2065-10-10T10:00:00Z", 20);

    const { body } = await insights(admin, { id: site.id, days: 7 });

    expect(point(body.data.series, "2065-10-10")).toEqual({
      date: "2065-10-10",
      views: 2,
      visitors: 2,
      activeSeconds: 30,
    });
    expect(body.data.totals).toMatchObject({
      views: 2,
      visitors: 2,
      activeSeconds: 30,
      averageSeconds: 15,
    });
    expect(body.data.totals.visitors).toBeLessThanOrEqual(
      body.data.totals.views
    );
    expect(body.data.pages).toEqual([
      { pageKey: "/a", title: "/a", views: 2, visitors: 2, averageSeconds: 15 },
    ]);
  });

  it("reads a settled day that has a stored row from the stored row only", async () => {
    const { admin, site } = await setup();
    await event(site.id, "/a", "s1", "2065-10-10T09:00:00Z", 10);
    await event(site.id, "/a", "s2", "2065-10-10T10:00:00Z", 20);
    await stored(site.id, "2065-10-10", "", D, 5, 4, 50, { "10-29": 5 });
    await stored(site.id, "2065-10-10", "/a", D, 5, 4, 50, { "10-29": 5 });

    const { body } = await insights(admin, { id: site.id, days: 7 });

    expect(point(body.data.series, "2065-10-10")).toEqual({
      date: "2065-10-10",
      views: 5,
      visitors: 4,
      activeSeconds: 50,
    });
    expect(body.data.totals).toMatchObject({
      views: 5,
      activeSeconds: 50,
      averageSeconds: 10,
    });
    expect(body.data.pages).toMatchObject([
      { pageKey: "/a", title: "/a", views: 5, averageSeconds: 10 },
    ]);
  });

  it("keeps a day outside raw retention without a stored row at zero", async () => {
    const { admin, site } = await setup();
    // Present in the table, but past retention: must not be read.
    await event(site.id, "/a", "s1", "2065-09-20T09:00:00Z", 10);
    const spy = vi
      .spyOn(pagesEnv, "PAGES_EVENT_RETENTION_DAYS", "get")
      .mockReturnValue(14);
    try {
      const { res, body } = await insights(admin, { id: site.id, days: 30 });
      expect(res.status).toEqual(200);
      expect(point(body.data.series, "2065-09-20")).toEqual({
        date: "2065-09-20",
        views: 0,
        visitors: 0,
        activeSeconds: 0,
      });
      expect(body.data.totals.views).toEqual(0);
      expect(body.data.pages).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  describe("the first settled day, three days before today", () => {
    it("is read from its stored row when it has one", async () => {
      const { admin, site } = await setup();
      await event(site.id, "/a", "s1", "2065-10-11T09:00:00Z", 10);
      await stored(site.id, "2065-10-11", "", D, 7, 6, 70, { "10-29": 7 });

      const { body } = await insights(admin, { id: site.id, days: 7 });
      expect(point(body.data.series, "2065-10-11")).toEqual({
        date: "2065-10-11",
        views: 7,
        visitors: 6,
        activeSeconds: 70,
      });
    });

    it("is read from raw events when it has none", async () => {
      const { admin, site } = await setup();
      await event(site.id, "/a", "s1", "2065-10-11T09:00:00Z", 10);

      const { body } = await insights(admin, { id: site.id, days: 7 });
      expect(point(body.data.series, "2065-10-11")).toEqual({
        date: "2065-10-11",
        views: 1,
        visitors: 1,
        activeSeconds: 10,
      });
    });
  });

  it("includes stored weekly site-wide and per-page rows with the right period", async () => {
    const { admin, site } = await setup();
    // Weeks starting 23 and 16 days ago, written by a rollup long ago.
    await stored(site.id, "2065-09-21", "", W, 12, 8, 360, { "10-29": 12 });
    await stored(site.id, "2065-09-21", "/a", W, 9, 6, 270, { "10-29": 9 });
    await stored(site.id, "2065-09-21", "/b", W, 3, 3, 90, { "10-29": 3 });
    await stored(site.id, "2065-09-28", "", W, 4, 3, 80, { "0-9": 4 });
    await stored(site.id, "2065-09-28", "/a", W, 4, 3, 80, { "0-9": 4 });
    // Day rows on the same dates: a wrong period filter would read these.
    await stored(site.id, "2065-09-21", "", D, 1000, 1000, 9999, {
      "0-9": 1000,
    });
    await stored(site.id, "2065-09-21", "/z", D, 1000, 1000, 9999, {});
    // The current week, live.
    await event(site.id, "/b", "s1", "2065-10-13T09:00:00Z", 10);

    const exact = await insights(admin, {
      id: site.id,
      period: "week",
      days: 30,
    });
    expect(exact.body.data.series).toEqual([
      { date: "2065-09-14", views: 0, visitors: 0, activeSeconds: 0 },
      { date: "2065-09-21", views: 12, visitors: 8, activeSeconds: 360 },
      { date: "2065-09-28", views: 4, visitors: 3, activeSeconds: 80 },
      { date: "2065-10-05", views: 0, visitors: 0, activeSeconds: 0 },
      { date: "2065-10-12", views: 1, visitors: 1, activeSeconds: 10 },
    ]);
    // 17 views, 450 seconds; histogram 0-9:4 10-29:13, rank 8.5 is 4.5/13
    // into 10-29: 10 + 4.5/13 * 20 = 16.9.
    expect(exact.body.data.totals).toMatchObject({
      views: 17,
      activeSeconds: 450,
      averageSeconds: 26,
      medianSeconds: 17,
    });

    // With a short retention the range is beyond raw events: visitors and
    // per-page visitors are the sums of the stored counts.
    const spy = vi
      .spyOn(pagesEnv, "PAGES_EVENT_RETENTION_DAYS", "get")
      .mockReturnValue(14);
    try {
      const { body } = await insights(admin, {
        id: site.id,
        period: "week",
        days: 30,
      });
      expect(body.data.totals).toMatchObject({
        views: 17,
        visitors: 12,
        visitorsApproximate: true,
      });
      expect(body.data.pages).toEqual([
        {
          pageKey: "/a",
          title: "/a",
          views: 13,
          visitors: 9,
          averageSeconds: 27,
        },
        {
          pageKey: "/b",
          title: "/b",
          views: 4,
          visitors: 4,
          averageSeconds: 25,
        },
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});
