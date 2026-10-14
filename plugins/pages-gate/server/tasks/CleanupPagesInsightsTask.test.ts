import { PagesInsight, PagesViewEvent } from "@server/models";
import { PagesInsightPeriod } from "@server/models/PagesInsight";
import { buildPagesSite, buildPagesViewEvent } from "../test/factories";

vi.setConfig({ testTimeout: 30000 });

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

const props = (limit = 10000) => ({
  limit,
  partition: { partitionIndex: 0, partitionCount: 1 },
});

async function loadTask(retention?: string) {
  if (retention === undefined) {
    delete process.env.PAGES_EVENT_RETENTION_DAYS;
  } else {
    process.env.PAGES_EVENT_RETENTION_DAYS = retention;
  }
  vi.resetModules();
  const { default: Task } = await import("./CleanupPagesInsightsTask");
  return new Task();
}

async function eventAges(siteId: string) {
  const events = await PagesViewEvent.findAll({ where: { siteId } });
  return events.map((e) => e.sessionId).sort();
}

describe("CleanupPagesInsightsTask", () => {
  afterEach(() => {
    delete process.env.PAGES_EVENT_RETENTION_DAYS;
  });

  async function seedEvents(siteId: string) {
    const cases: [string, number][] = [
      ["d89", 89 * DAY],
      ["d90-1m", 90 * DAY - MINUTE],
      ["d90+1m", 90 * DAY + MINUTE],
      ["d91", 91 * DAY],
      ["d31", 31 * DAY],
      ["d29", 29 * DAY],
    ];
    for (const [sessionId, age] of cases) {
      await buildPagesViewEvent({ siteId, sessionId, startedAt: ago(age) });
    }
  }

  it("keeps events inside the default 90 day window", async () => {
    const site = await buildPagesSite();
    await seedEvents(site.id);

    await (await loadTask()).perform(props());

    expect(await eventAges(site.id)).toEqual(["d29", "d31", "d89", "d90-1m"]);
  });

  it("honours PAGES_EVENT_RETENTION_DAYS", async () => {
    const site = await buildPagesSite();
    await seedEvents(site.id);

    await (await loadTask("30")).perform(props());

    expect(await eventAges(site.id)).toEqual(["d29"]);
  });

  it.each(["0", "1", "7", "13", "731", "abc", "14.5", ""])(
    "falls back to 90 days for %j",
    async (value) => {
      const site = await buildPagesSite();
      await seedEvents(site.id);

      await (await loadTask(value)).perform(props());

      expect(await eventAges(site.id)).toEqual(["d29", "d31", "d89", "d90-1m"]);
    }
  );

  it.each(["14", "730"])("accepts %s days", async (value) => {
    const site = await buildPagesSite();
    await buildPagesViewEvent({
      siteId: site.id,
      sessionId: "edge",
      startedAt: ago(Number(value) * DAY - MINUTE),
    });
    await buildPagesViewEvent({
      siteId: site.id,
      sessionId: "past",
      startedAt: ago(Number(value) * DAY + MINUTE),
    });

    await (await loadTask(value)).perform(props());

    expect(await eventAges(site.id)).toEqual(["edge"]);
  });

  it("leaves rollups intact when cleanup at minimum retention precedes a rollup", async () => {
    const site = await buildPagesSite();
    const midnight = Date.now() - (Date.now() % DAY);
    const monday = midnight - ((new Date(midnight).getUTCDay() + 6) % 7) * DAY;
    // Spread over the previous and the current UTC week, all within 14 days.
    const kept = [monday - 7 * DAY + 3600000, monday - 2 * DAY, monday + 1000];
    for (const [i, t] of kept.entries()) {
      await buildPagesViewEvent({
        siteId: site.id,
        sessionId: `k${i}`,
        startedAt: new Date(Math.min(t, Date.now() - 1000)),
        activeSeconds: 20,
      });
    }

    const task = await loadTask("14");
    const { default: Rollup } = await import("./RollupPagesInsightsTask");
    const rollup = new Rollup();
    await rollup.perform(props());
    const snapshot = async () =>
      (await PagesInsight.findAll({ where: { siteId: site.id } }))
        .map((r) => [
          r.pageKey,
          r.date,
          r.period,
          r.viewCount,
          r.visitorCount,
          r.totalActiveSeconds,
          JSON.stringify(r.timeHistogram),
        ])
        .sort((a, b) => String(a).localeCompare(String(b)));
    const before = await snapshot();
    const weekRows = before.filter((r) => r[2] === "week");
    expect(weekRows.length).toBeGreaterThan(0);

    // Events past the window belong to no recomputed period.
    for (const [i, age] of [15, 20].entries()) {
      await buildPagesViewEvent({
        siteId: site.id,
        sessionId: `old${i}`,
        startedAt: ago(age * DAY),
      });
    }
    await task.perform(props());
    expect(await PagesViewEvent.count({ where: { siteId: site.id } })).toBe(3);
    await rollup.perform(props());

    expect(await snapshot()).toEqual(before);
  });

  it("deletes rollups older than 365 days only", async () => {
    const site = await buildPagesSite();
    const day = (n: number) =>
      new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
    for (const n of [364, 365, 366]) {
      await PagesInsight.create({
        siteId: site.id,
        pageKey: "",
        date: day(n),
        period: PagesInsightPeriod.Day,
      });
    }

    await (await loadTask()).perform(props());

    const dates = (await PagesInsight.findAll({ where: { siteId: site.id } }))
      .map((r) => r.date)
      .sort();
    expect(dates).toEqual([day(365), day(364)].sort());
  });

  it("deletes a backlog in bounded batches and stops", async () => {
    const site = await buildPagesSite();
    for (let i = 0; i < 7; i++) {
      await buildPagesViewEvent({
        siteId: site.id,
        sessionId: `old${i}`,
        startedAt: ago(120 * DAY),
      });
    }
    await buildPagesViewEvent({ siteId: site.id, sessionId: "fresh" });

    await (await loadTask()).perform(props(3));

    expect(await eventAges(site.id)).toEqual(["fresh"]);
  });

  it("stops when the backlog is an exact multiple of the batch", async () => {
    const site = await buildPagesSite();
    for (let i = 0; i < 6; i++) {
      await buildPagesViewEvent({
        siteId: site.id,
        sessionId: `old${i}`,
        startedAt: ago(120 * DAY),
      });
    }

    await (await loadTask()).perform(props(3));

    expect(await PagesViewEvent.count({ where: { siteId: site.id } })).toBe(0);
  });
});
