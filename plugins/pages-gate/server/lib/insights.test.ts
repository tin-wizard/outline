import { medianFromHistogram, resolveRange } from "./insights";

describe("medianFromHistogram", () => {
  it("is 0 for an empty histogram", () => {
    expect(medianFromHistogram({})).toEqual(0);
    expect(medianFromHistogram({ "0-9": 0, "600+": 0 })).toEqual(0);
  });

  it("interpolates linearly inside a single bucket", () => {
    // Four views in 10-29: the 50th percentile is halfway through it.
    expect(medianFromHistogram({ "10-29": 4 })).toEqual(20);
    // One view in 30-59: the rank 0.5 sits halfway up the bucket.
    expect(medianFromHistogram({ "30-59": 1 })).toEqual(45);
  });

  it("interpolates inside the bucket that holds the middle rank", () => {
    // 6 views, rank 3: the first bucket reaching it is 0-9, at its top.
    expect(medianFromHistogram({ "0-9": 3, "10-29": 3 })).toEqual(10);
    // 5 views, rank 2.5: 0.5 of the 3 views in 10-29 is a sixth of the way.
    expect(medianFromHistogram({ "0-9": 2, "10-29": 3 })).toEqual(13);
    // 4 views, rank 2: one of three into 60-179, empty buckets are skipped.
    expect(medianFromHistogram({ "0-9": 1, "60-179": 3 })).toEqual(100);
  });

  it("treats the open 600+ bucket as 600 to 1800", () => {
    expect(medianFromHistogram({ "600+": 2 })).toEqual(1200);
    expect(medianFromHistogram({ "600+": 1 })).toEqual(1200);
    expect(medianFromHistogram({ "0-9": 1, "600+": 3 })).toEqual(
      Math.round(600 + ((2 - 1) / 3) * 1200)
    );
    expect(medianFromHistogram({ "600+": 1000 })).toBeLessThanOrEqual(1800);
  });

  it("ignores unknown keys", () => {
    expect(medianFromHistogram({ "10-29": 2, "x-y": 100 })).toEqual(20);
  });
});

describe("resolveRange", () => {
  // Wednesday.
  const now = Date.parse("2037-10-14T12:00:00Z");

  it("lists UTC days ending today and settles all but the last three", () => {
    const range = resolveRange(now, "day", 7);
    expect(range.starts).toEqual([
      "2037-10-08",
      "2037-10-09",
      "2037-10-10",
      "2037-10-11",
      "2037-10-12",
      "2037-10-13",
      "2037-10-14",
    ]);
    expect(range.liveFrom).toEqual("2037-10-12");
    expect(range.end.toISOString()).toEqual("2037-10-15T00:00:00.000Z");
    expect(range.to).toEqual("2037-10-14");
  });

  it("lists Monday weeks, rounding days up, and settles all but two", () => {
    const range = resolveRange(now, "week", 30);
    expect(range.starts).toEqual([
      "2037-09-14",
      "2037-09-21",
      "2037-09-28",
      "2037-10-05",
      "2037-10-12",
    ]);
    expect(range.liveFrom).toEqual("2037-10-05");
    expect(range.end.toISOString()).toEqual("2037-10-19T00:00:00.000Z");
    expect(range.to).toEqual("2037-10-14");
    expect(resolveRange(now, "week", 7).starts).toEqual(["2037-10-12"]);
    expect(resolveRange(now, "week", 90).starts).toHaveLength(13);
  });

  it("puts Sunday in the week that began the Monday before", () => {
    const sunday = Date.parse("2037-10-18T23:59:59Z");
    expect(resolveRange(sunday, "week", 7).starts).toEqual(["2037-10-12"]);
    const monday = Date.parse("2037-10-19T00:00:00Z");
    expect(resolveRange(monday, "week", 7).starts).toEqual(["2037-10-19"]);
  });
});
