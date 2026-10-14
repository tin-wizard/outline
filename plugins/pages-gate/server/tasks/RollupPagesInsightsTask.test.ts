import { randomUUID } from "node:crypto";
import { PagesInsight } from "@server/models";
import { PagesInsightPeriod } from "@server/models/PagesInsight";
import { buildPagesSite, buildPagesViewEvent } from "../test/factories";
import RollupPagesInsightsTask from "./RollupPagesInsightsTask";

vi.setConfig({ testTimeout: 30000 });

// A far-future Wednesday so the cleanup tests never delete these events.
// Current UTC week starts Monday 2037-10-12, previous 2037-10-05.
const NOW = new Date("2037-10-14T12:00:00Z");

const props = (partitionIndex = 0, partitionCount = 1) => ({
  limit: 10000,
  partition: { partitionIndex, partitionCount },
});

const at = (iso: string) => new Date(iso);

async function rows(siteId: string) {
  const found = await PagesInsight.findAll({
    where: { siteId },
    order: [
      ["period", "ASC"],
      ["date", "ASC"],
      ["pageKey", "ASC"],
    ],
  });
  return found.map((r) => ({
    pageKey: r.pageKey,
    date: r.date,
    period: r.period,
    viewCount: r.viewCount,
    visitorCount: r.visitorCount,
    totalActiveSeconds: r.totalActiveSeconds,
    timeHistogram: r.timeHistogram,
  }));
}

describe("RollupPagesInsightsTask", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts views, distinct visitors, active seconds and histogram buckets", async () => {
    const site = await buildPagesSite();
    const startedAt = at("2037-10-14T09:00:00Z");
    const seconds = [0, 9, 10, 29, 30, 59, 60, 179, 180, 599, 600];
    for (const [i, activeSeconds] of seconds.entries()) {
      await buildPagesViewEvent({
        siteId: site.id,
        pageKey: "/a",
        sessionId: `s${i % 2}`,
        startedAt: new Date(startedAt.getTime() + i * 1000),
        activeSeconds,
      });
    }
    // s0 also visits /b; s2 only /b.
    await buildPagesViewEvent({
      siteId: site.id,
      pageKey: "/b",
      sessionId: "s0",
      startedAt,
      activeSeconds: 5,
    });
    await buildPagesViewEvent({
      siteId: site.id,
      pageKey: "/b",
      sessionId: "s2",
      startedAt,
      activeSeconds: 700,
    });

    await new RollupPagesInsightsTask().perform(props());

    const day = (await rows(site.id)).filter(
      (r) => r.period === PagesInsightPeriod.Day
    );
    expect(day).toEqual([
      {
        pageKey: "",
        date: "2037-10-14",
        period: "day",
        viewCount: 13,
        visitorCount: 3,
        totalActiveSeconds: 1755 + 5 + 700,
        timeHistogram: {
          "0-9": 3,
          "10-29": 2,
          "30-59": 2,
          "60-179": 2,
          "180-599": 2,
          "600+": 2,
        },
      },
      {
        pageKey: "/a",
        date: "2037-10-14",
        period: "day",
        viewCount: 11,
        visitorCount: 2,
        totalActiveSeconds: 1755,
        timeHistogram: {
          "0-9": 2,
          "10-29": 2,
          "30-59": 2,
          "60-179": 2,
          "180-599": 2,
          "600+": 1,
        },
      },
      {
        pageKey: "/b",
        date: "2037-10-14",
        period: "day",
        viewCount: 2,
        visitorCount: 2,
        totalActiveSeconds: 705,
        timeHistogram: {
          "0-9": 1,
          "10-29": 0,
          "30-59": 0,
          "60-179": 0,
          "180-599": 0,
          "600+": 1,
        },
      },
    ]);
  });

  it("assigns days and weeks by the UTC start, week dated on Monday", async () => {
    const site = await buildPagesSite();
    const instants = [
      "2037-10-12T23:59:59Z",
      "2037-10-13T00:00:00Z",
      "2037-10-11T23:59:59Z", // Sunday, previous week
      "2037-10-12T00:00:00Z", // Monday, current week
    ];
    for (const [i, iso] of instants.entries()) {
      await buildPagesViewEvent({
        siteId: site.id,
        pageKey: "/p",
        sessionId: `s${i}`,
        startedAt: at(iso),
      });
    }

    await new RollupPagesInsightsTask().perform(props());

    const found = (await rows(site.id)).filter((r) => r.pageKey === "/p");
    const summary = found.map((r) => [r.period, r.date, r.viewCount]);
    expect(summary).toEqual([
      ["day", "2037-10-12", 2],
      ["day", "2037-10-13", 1],
      ["week", "2037-10-05", 1],
      ["week", "2037-10-12", 3],
    ]);
  });

  it("is idempotent and settles late events", async () => {
    const site = await buildPagesSite();
    await buildPagesViewEvent({
      siteId: site.id,
      sessionId: "a",
      startedAt: at("2037-10-14T01:00:00Z"),
      activeSeconds: 12,
    });
    const task = new RollupPagesInsightsTask();

    await task.perform(props());
    const first = await rows(site.id);
    await task.perform(props());
    expect(await rows(site.id)).toEqual(first);
    expect(await PagesInsight.count({ where: { siteId: site.id } })).toBe(
      first.length
    );

    await buildPagesViewEvent({
      siteId: site.id,
      sessionId: "b",
      startedAt: at("2037-10-14T02:00:00Z"),
      activeSeconds: 40,
    });
    await task.perform(props());
    const day = (await rows(site.id)).find(
      (r) => r.period === "day" && r.pageKey === "/"
    );
    expect(day).toMatchObject({
      viewCount: 2,
      visitorCount: 2,
      totalActiveSeconds: 52,
    });
  });

  it("does not rewrite periods older than the recompute window", async () => {
    const site = await buildPagesSite();
    await buildPagesViewEvent({
      siteId: site.id,
      startedAt: at("2037-10-09T10:00:00Z"),
    });
    await PagesInsight.create({
      siteId: site.id,
      pageKey: "/",
      date: "2037-10-09",
      period: PagesInsightPeriod.Day,
      viewCount: 99,
    });

    await new RollupPagesInsightsTask().perform(props());

    const day = await PagesInsight.findOne({
      where: { siteId: site.id, period: "day", date: "2037-10-09" },
    });
    expect(day?.viewCount).toBe(99);
    // No site-wide day row was created for the old day either.
    expect(
      await PagesInsight.count({
        where: { siteId: site.id, period: "day", date: "2037-10-09" },
      })
    ).toBe(1);
  });

  it("keeps sites separate and writes rows when measurement is off", async () => {
    const one = await buildPagesSite({ measurementEnabled: false });
    const two = await buildPagesSite();
    const startedAt = at("2037-10-14T03:00:00Z");
    await buildPagesViewEvent({
      siteId: one.id,
      sessionId: "same",
      startedAt,
    });
    await buildPagesViewEvent({
      siteId: two.id,
      sessionId: "same",
      startedAt,
    });
    await buildPagesViewEvent({
      siteId: two.id,
      sessionId: "other",
      startedAt,
    });
    const idle = await buildPagesSite();

    await new RollupPagesInsightsTask().perform(props());

    const siteWide = (id: string) =>
      PagesInsight.findOne({
        where: { siteId: id, period: "day", pageKey: "" },
      });
    expect((await siteWide(one.id))?.viewCount).toBe(1);
    expect((await siteWide(two.id))?.viewCount).toBe(2);
    expect((await siteWide(two.id))?.visitorCount).toBe(2);
    expect(await PagesInsight.count({ where: { siteId: idle.id } })).toBe(0);
  });

  it("only rolls up sites inside the partition bounds", async () => {
    const low = await buildPagesSite({ id: `1${randomUUID().slice(1)}` });
    const high = await buildPagesSite({ id: `f${randomUUID().slice(1)}` });
    const startedAt = at("2037-10-14T03:00:00Z");
    await buildPagesViewEvent({ siteId: low.id, startedAt });
    await buildPagesViewEvent({ siteId: high.id, startedAt });
    const task = new RollupPagesInsightsTask();

    await task.perform(props(0, 2));
    expect(
      await PagesInsight.count({ where: { siteId: low.id } })
    ).toBeGreaterThan(0);
    expect(await PagesInsight.count({ where: { siteId: high.id } })).toBe(0);

    await task.perform(props(1, 2));
    expect(
      await PagesInsight.count({ where: { siteId: high.id } })
    ).toBeGreaterThan(0);
  });

  it("survives two parallel runs", async () => {
    const site = await buildPagesSite();
    for (let i = 0; i < 20; i++) {
      await buildPagesViewEvent({
        siteId: site.id,
        pageKey: `/p${i % 5}`,
        sessionId: `s${i}`,
        startedAt: at("2037-10-14T04:00:00Z"),
        activeSeconds: i,
      });
    }
    const task = new RollupPagesInsightsTask();
    await task.perform(props());
    const expected = await rows(site.id);
    await PagesInsight.destroy({ where: { siteId: site.id } });

    await Promise.all([task.perform(props()), task.perform(props())]);

    expect(await rows(site.id)).toEqual(expected);
  });
});
