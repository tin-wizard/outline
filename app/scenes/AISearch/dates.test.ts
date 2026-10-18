import { formatWhen, isStale, STALE_DAYS } from "./dates";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const daysAgo = (days: number) =>
  new Date(NOW - days * 86_400_000).toISOString();

describe("isStale", () => {
  it("flags sources not updated for more than 180 days", () => {
    expect(STALE_DAYS).toBe(180);
    expect(isStale(daysAgo(181), NOW)).toBe(true);
    expect(isStale(daysAgo(180), NOW)).toBe(false);
    expect(isStale(daysAgo(3), NOW)).toBe(false);
  });

  it("never flags a missing or invalid date", () => {
    expect(isStale(undefined, NOW)).toBe(false);
    expect(isStale("not a date", NOW)).toBe(false);
  });
});

describe("formatWhen", () => {
  it("formats a day in the user's locale", () => {
    expect(formatWhen("2026-10-14T10:00:00.000Z", "en_US")).toBe(
      "Oct 14, 2026"
    );
    expect(formatWhen("2026-10-14T10:00:00.000Z", "de_DE")).toBe("14.10.2026");
  });

  it("can format in UTC for limits that reset at a UTC boundary", () => {
    expect(formatWhen("2026-11-01T00:00:00.000Z", "en_US", { utc: true })).toBe(
      "Nov 1, 2026"
    );
  });

  it("adds the time of day on request", () => {
    expect(
      formatWhen("2026-10-19T00:00:00.000Z", "en_US", { time: true, utc: true })
    ).toMatch(/^Oct 19, 2026,? 12:00 AM$/);
  });

  it("returns undefined for missing or invalid input and falls back for odd locales", () => {
    expect(formatWhen(undefined, "en_US")).toBeUndefined();
    expect(formatWhen("nope", "en_US")).toBeUndefined();
    expect(formatWhen("2026-10-14T10:00:00.000Z", "zz_??")).toBeTruthy();
  });
});
