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
    expect(
      toKeywords("alpha alpha beta gamma delta epsilon zeta eta theta iota")
    ).toEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "zeta",
      "eta",
      "theta",
    ]);
  });

  it("keeps accented and decomposed letters", () => {
    expect(toKeywords("café Müller")).toEqual(["café", "müller"]);
    expect(toKeywords("Müller")).toEqual(["müller"]);
  });

  it("keeps two-character CJK words", () => {
    expect(toKeywords("休暇 ポリシー")).toEqual(["休暇", "ポリシー"]);
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

  it("returns matching sections in document order when several fit", () => {
    const out = selectSections(sections, ["holiday"], 1000);
    expect(out).toEqual([sections[1], sections[2]]);
  });

  it("omits sections that match no keyword when another section matches", () => {
    const out = selectSections(
      ["# A\nnothing here", "# B\nholiday policy", "# C\nunrelated"],
      ["holiday"],
      1000
    );
    expect(out).toEqual(["# B\nholiday policy"]);
  });

  it("falls back to document order within the budget when nothing matches", () => {
    const out = selectSections(sections, ["zzz"], 1000);
    expect(out).toEqual(sections);

    // "# A\nnothing here" is 16 chars and "# B\nholiday policy" is 18.
    expect(selectSections(sections, ["zzz"], 34)).toEqual([
      sections[0],
      sections[1],
    ]);
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
