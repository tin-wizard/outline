import {
  isValidSlug,
  RESERVED_SLUGS as SERVER_RESERVED_SLUGS,
} from "../server/lib/keys";
import { RESERVED_SLUGS, slugProblem } from "./slug";

describe("slugProblem", () => {
  it("accepts valid slugs at the length boundaries", () => {
    expect(slugProblem("abc")).toBeUndefined();
    expect(slugProblem("a".repeat(40))).toBeUndefined();
    expect(slugProblem("team-handbook-2026")).toBeUndefined();
  });

  it("refuses lengths of 2 and 41", () => {
    expect(slugProblem("ab")).toBe("length");
    expect(slugProblem("")).toBe("length");
    expect(slugProblem("a".repeat(41))).toBe("length");
  });

  it("refuses bad characters and hyphen placement", () => {
    for (const bad of [
      "-abc",
      "abc-",
      "a--bc",
      "ABC",
      "ab c",
      "ab_c",
      "abc/def",
      " abc",
      "abc.html",
    ]) {
      expect(slugProblem(bad)).toBe("pattern");
    }
  });

  it("refuses every reserved slug that otherwise passes", () => {
    expect(slugProblem("platform-architecture")).toBe("reserved");
    expect(slugProblem("platform-onboarding")).toBe("reserved");
    expect(slugProblem("implexus-platform")).toBe("reserved");
    // Reserved but not matching the pattern: the pattern is reported first.
    expect(slugProblem("robots.txt")).toBe("pattern");
    expect(slugProblem("_headers")).toBe("pattern");
  });

  it("agrees with the server on valid and invalid inputs", () => {
    const samples = [
      ...SERVER_RESERVED_SLUGS,
      "abc",
      "ab",
      "a".repeat(40),
      "a".repeat(41),
      "-abc",
      "a--b",
      "abc-",
      "ABC",
      "docs-1",
      "1-2-3",
    ];
    for (const sample of samples) {
      expect(slugProblem(sample) === undefined).toBe(isValidSlug(sample));
    }
  });

  it("has the same reserved list as the server", () => {
    expect([...RESERVED_SLUGS].sort()).toEqual(
      [...SERVER_RESERVED_SLUGS].sort()
    );
  });
});
