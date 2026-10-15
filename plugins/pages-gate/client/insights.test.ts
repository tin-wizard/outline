import type { InsightsData } from "./types";
import {
  formatDuration,
  insightsLoadReducer,
  type InsightsLoadState,
  insightsViewState,
  normaliseSeries,
  pageLink,
} from "./insights";

describe("formatDuration", () => {
  it.each([
    [0, "0:00"],
    [5, "0:05"],
    [59, "0:59"],
    [60, "1:00"],
    [75, "1:15"],
    [599, "9:59"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3661, "1:01:01"],
    [36000, "10:00:00"],
    [86399, "23:59:59"],
  ])("formats %d seconds as %s", (seconds, expected) => {
    expect(formatDuration(seconds)).toEqual(expected);
  });

  it("rounds fractions and clamps bad input to zero", () => {
    expect(formatDuration(59.6)).toEqual("1:00");
    expect(formatDuration(-4)).toEqual("0:00");
    expect(formatDuration(Number.NaN)).toEqual("0:00");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toEqual("0:00");
  });
});

describe("normaliseSeries", () => {
  const point = (date: string, views: number) => ({
    date,
    views,
    visitors: 0,
    activeSeconds: 0,
  });

  it("scales bars against the largest value", () => {
    const bars = normaliseSeries([
      point("2037-10-12", 2),
      point("2037-10-13", 8),
      point("2037-10-14", 0),
    ]);
    expect(bars.map((b) => b.ratio)).toEqual([0.25, 1, 0]);
    expect(bars.map((b) => b.date)).toEqual([
      "2037-10-12",
      "2037-10-13",
      "2037-10-14",
    ]);
  });

  it("gives every bar a ratio of 0 when there are no views", () => {
    expect(normaliseSeries([point("a", 0), point("b", 0)])).toEqual([
      { date: "a", views: 0, ratio: 0 },
      { date: "b", views: 0, ratio: 0 },
    ]);
    expect(normaliseSeries([])).toEqual([]);
  });

  it("keeps a visible sliver for a non-zero value", () => {
    const [small, big] = normaliseSeries([point("a", 1), point("b", 10000)]);
    expect(small.ratio).toBeGreaterThan(0);
    expect(big.ratio).toEqual(1);
  });
});

describe("insightsViewState", () => {
  const totals = (views: number) => ({ views });

  it("says a draft was never published", () => {
    expect(
      insightsViewState(
        { status: "draft" },
        { measurementEnabled: true, totals: totals(0) }
      )
    ).toEqual("never-published");
  });

  it("explains measurement being off when there is nothing to show", () => {
    expect(
      insightsViewState(
        { status: "published" },
        { measurementEnabled: false, totals: totals(0) }
      )
    ).toEqual("measurement-off");
  });

  it("shows history even when measurement is now off", () => {
    expect(
      insightsViewState(
        { status: "unpublished" },
        { measurementEnabled: false, totals: totals(3) }
      )
    ).toEqual("data");
  });

  it("says no data yet when measurement is on and nothing arrived", () => {
    expect(
      insightsViewState(
        { status: "published" },
        { measurementEnabled: true, totals: totals(0) }
      )
    ).toEqual("no-data");
  });

  it("shows data otherwise", () => {
    expect(
      insightsViewState(
        { status: "published" },
        { measurementEnabled: true, totals: totals(1) }
      )
    ).toEqual("data");
  });
});

describe("pageLink", () => {
  const entry = "https://pages.example.com/sites/guide/index.html";

  it("resolves a page key against the site's entry address", () => {
    expect(pageLink(entry, "docs/setup.html")).toEqual(
      "https://pages.example.com/sites/guide/docs/setup.html"
    );
    expect(pageLink(entry, "index.html")).toEqual(entry);
  });

  it("returns null when unpublished or the key would leave the site", () => {
    expect(pageLink(null, "index.html")).toBeNull();
    expect(pageLink(entry, "//evil.example/x")).toBeNull();
    expect(pageLink(entry, "https://evil.example/x")).toBeNull();
    expect(pageLink(entry, "javascript:alert(1)")).toBeNull();
    expect(pageLink(entry, "../other/index.html")).toBeNull();
  });
});

describe("insightsLoadReducer", () => {
  const data = { period: "day" } as unknown as InsightsData;
  const ready: InsightsLoadState = {
    days: 30,
    period: "day",
    reload: 0,
    status: "ready",
    data,
  };

  it("ignores choosing the value that is already selected", () => {
    expect(insightsLoadReducer(ready, { type: "choose", days: 30 })).toBe(
      ready
    );
    expect(insightsLoadReducer(ready, { type: "choose", period: "day" })).toBe(
      ready
    );
    const failed: InsightsLoadState = { ...ready, status: "error", data: null };
    expect(insightsLoadReducer(failed, { type: "choose", days: 30 })).toBe(
      failed
    );
  });

  it("clears and reloads when a different value is chosen", () => {
    const next = insightsLoadReducer(ready, { type: "choose", period: "week" });
    expect(next).toEqual({
      days: 30,
      period: "week",
      reload: 0,
      status: "loading",
      data: null,
    });
    // The fetch is keyed on days, period and reload: one of them changed.
    expect(next.period).not.toEqual(ready.period);
  });

  it("retries from the error state by bumping the reload counter", () => {
    const failed = insightsLoadReducer(
      insightsLoadReducer(ready, { type: "choose", days: 7 }),
      { type: "failed" }
    );
    expect(failed.status).toEqual("error");
    const retried = insightsLoadReducer(failed, { type: "retry" });
    expect(retried).toMatchObject({ status: "loading", reload: 1, days: 7 });
    // Retry does nothing unless an error is showing.
    expect(insightsLoadReducer(ready, { type: "retry" })).toBe(ready);
  });

  it("stores a loaded result", () => {
    const loading = insightsLoadReducer(ready, { type: "choose", days: 90 });
    expect(
      insightsLoadReducer(loading, { type: "loaded", data })
    ).toMatchObject({ status: "ready", data });
  });
});
