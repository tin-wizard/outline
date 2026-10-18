import { startedLabel } from "./startedLabel";

describe("startedLabel", () => {
  it("formats weekday, month and day", () => {
    expect(startedLabel("2026-10-16T12:00:00.000Z", "en_US")).toBe(
      "Fri, Oct 16"
    );
  });

  it("falls back silently for missing or invalid dates", () => {
    expect(startedLabel(undefined)).toBeUndefined();
    expect(startedLabel(null)).toBeUndefined();
    expect(startedLabel("not a date")).toBeUndefined();
  });

  it("survives an unusable language", () => {
    expect(startedLabel("2026-10-16T12:00:00.000Z", "!!")).toMatch(/16/);
  });
});
