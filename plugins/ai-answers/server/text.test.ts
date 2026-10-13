import {
  headingOf,
  selectSections,
  splitIntoSections,
  toKeywordQuery,
  toKeywords,
} from "./text";

describe("toKeywords", () => {
  it("drops stop words and punctuation", () => {
    expect(toKeywords("What is our holiday policy?")).toEqual([
      "holiday",
      "policy",
    ]);
  });

  it("returns nothing for a question of only stop words", () => {
    expect(toKeywords("what is the?")).toEqual([]);
  });

  it("returns nothing for symbols only", () => {
    expect(toKeywords("!!! ??? ***")).toEqual([]);
  });

  it("deduplicates and caps at eight", () => {
    const q = "alpha alpha beta gamma delta epsilon zeta eta theta iota kappa";
    expect(toKeywords(q)).toHaveLength(8);
    expect(toKeywords(q)[0]).toEqual("alpha");
  });

  it("keeps non-English words", () => {
    expect(toKeywords("¿Cuál es la política de vacaciones?")).toContain(
      "vacaciones"
    );
  });
});

describe("toKeywordQuery", () => {
  it("joins with or", () => {
    expect(toKeywordQuery(["holiday", "policy"])).toEqual("holiday or policy");
  });
});

describe("splitIntoSections", () => {
  it("splits on headings and keeps the heading with its body", () => {
    const md = "intro\n\n# One\nfirst\n\n## Two\nsecond";
    expect(splitIntoSections(md)).toEqual([
      "intro",
      "# One\nfirst",
      "## Two\nsecond",
    ]);
  });

  it("splits an oversized section on blank lines", () => {
    const md = `# Big\n${"a".repeat(60)}\n\n${"b".repeat(60)}`;
    const out = splitIntoSections(md, 80);
    expect(out.length).toEqual(2);
    expect(out[0]).toContain("# Big");
  });

  it("returns nothing for empty text", () => {
    expect(splitIntoSections("")).toEqual([]);
    expect(splitIntoSections("   \n\n ")).toEqual([]);
  });

  it("keeps a single huge paragraph whole instead of looping", () => {
    expect(splitIntoSections("x".repeat(5000), 100)).toEqual([
      "x".repeat(5000),
    ]);
  });
});

describe("selectSections", () => {
  const sections = ["# A\nnothing here", "# B\nholiday policy", "# C\nholiday"];

  it("prefers sections matching more keywords, in document order", () => {
    // "# B\nholiday policy" is 18 chars, "# C\nholiday" is 11: only one fits.
    const out = selectSections(sections, ["holiday", "policy"], 18);
    expect(out).toEqual(["# B\nholiday policy"]);
  });

  it("returns document order when several fit", () => {
    const out = selectSections(sections, ["holiday"], 1000);
    expect(out).toEqual(sections);
  });

  it("never exceeds the budget", () => {
    const out = selectSections(sections, ["holiday"], 20);
    expect(out.join("").length).toBeLessThanOrEqual(20);
  });
});

describe("headingOf", () => {
  it("reads the first heading line", () => {
    expect(headingOf("## Leave policy\nbody")).toEqual("Leave policy");
  });

  it("returns undefined without a heading", () => {
    expect(headingOf("just text")).toBeUndefined();
  });
});
