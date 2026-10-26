import {
  headingOf,
  selectSections,
  splitIntoSections,
  toKeywordAndQuery,
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

  it("deduplicates and caps at ten", () => {
    expect(
      toKeywords(
        "alpha alpha beta gamma delta epsilon zeta eta theta iota kappa lambda"
      )
    ).toEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "zeta",
      "eta",
      "theta",
      "iota",
      "kappa",
    ]);
  });

  it("keeps accented and decomposed letters", () => {
    expect(toKeywords("café Müller")).toEqual(["café", "müller"]);
    expect(toKeywords("Müller")).toEqual(["müller"]);
  });

  it("keeps two-character CJK words", () => {
    expect(toKeywords("休暇 ポリシー")).toEqual(["休暇", "ポリシー"]);
  });

  it("splits slug and path tokens and keeps the compound", () => {
    expect(toKeywords("mvanhorn/cli-printing-press")).toEqual([
      "mvanhorn",
      "cli",
      "printing",
      "press",
      "mvanhorn/cli-printing-press",
    ]);
    expect(toKeywords("where is the release_notes file?")).toEqual([
      "release",
      "notes",
      "release_notes",
      "file",
    ]);
  });

  it("keeps a dotted version as a compound", () => {
    expect(toKeywords("upgrade to v3.5")).toContain("v3.5");
  });

  it("keeps upper-case two-letter terms", () => {
    expect(toKeywords("What is our AI and HR policy, QA?")).toEqual([
      "ai",
      "hr",
      "policy",
      "qa",
    ]);
  });

  it("drops lower-case two-letter terms unless quoted", () => {
    expect(toKeywords("ai policy")).toEqual(["policy"]);
    expect(toKeywords('the "ai" policy')).toEqual(["ai", "policy"]);
    expect(toKeywords("WHAT IS AI")).toEqual(["ai"]);
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

describe("toKeywordAndQuery", () => {
  it("joins with spaces and leaves compounds out", () => {
    expect(
      toKeywordAndQuery(toKeywords("mvanhorn/cli-printing-press docs"))
    ).toEqual("mvanhorn cli printing press docs");
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
    // The opening section "# A\nnothing here" (16 chars) is pinned, then
    // "# B\nholiday policy" (18) fits but "# C\nholiday" (11) does not.
    const out = selectSections(sections, ["holiday", "policy"], 34);
    expect(out).toEqual([sections[0], sections[1]]);
  });

  it("returns matching sections in document order when several fit", () => {
    const out = selectSections(sections, ["holiday"], 1000);
    expect(out).toEqual([sections[0], sections[1], sections[2]]);
  });

  it("omits sections that match no keyword when another section matches", () => {
    const out = selectSections(
      ["# A\nnothing here", "# B\nholiday policy", "# C\nunrelated"],
      ["holiday"],
      1000
    );
    expect(out).toEqual(["# A\nnothing here", "# B\nholiday policy"]);
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

  describe("pinned opening section", () => {
    const doc = [
      "# Intro\nThe Stack is the register of tools.",
      "# Pricing\nCosts per seat.",
      "# Stack table\nstack product rows",
    ];
    const keywords = ["stack", "product"];

    it("returns the intro first and keeps document order", () => {
      expect(selectSections(doc, keywords, 10000)).toEqual([doc[0], doc[2]]);
    });

    it("keeps the intro and the best other section under a tight budget", () => {
      const budget = doc[0].length + doc[2].length;
      expect(selectSections(doc, keywords, budget)).toEqual([doc[0], doc[2]]);
    });

    it("returns an intro with no keyword match alongside a match", () => {
      const out = selectSections(
        ["# Overview\nGeneral words.", "# Other\nnothing", "# Stack\nstack"],
        ["stack"],
        10000
      );
      expect(out).toEqual(["# Overview\nGeneral words.", "# Stack\nstack"]);
    });

    it("skips an opening section larger than the budget", () => {
      const big = `# Intro\n${"x".repeat(100)}`;
      const out = selectSections([big, "# Stack\nstack"], ["stack"], 50);
      expect(out).toEqual(["# Stack\nstack"]);
    });

    it("never duplicates a section or exceeds the budget", () => {
      const out = selectSections(doc, keywords, 70);
      expect(new Set(out).size).toEqual(out.length);
      expect(out.join("").length).toBeLessThanOrEqual(70);
      expect(out[0]).toEqual(doc[0]);
    });
  });

  describe("heading weighting", () => {
    // Scores for keywords ["billing", "invoice"], excluding the pinned intro:
    // headed: 1 (text) + 2 (heading) = 3; body: 2 (text, none in heading) = 2.
    const intro = "# Intro\nWelcome.";
    const body = "# Notes\nbilling and invoice details";
    const headed = "# Billing\nsee finance";

    it("ranks a heading match above a larger body-only match", () => {
      const budget = intro.length + headed.length;
      const out = selectSections(
        [intro, body, headed],
        ["billing", "invoice"],
        budget
      );
      expect(out).toEqual([intro, headed]);
    });

    it("breaks ties by document order", () => {
      const a = "# One\nbilling";
      const b = "# Two\nbilling";
      const out = selectSections(
        [intro, a, b],
        ["billing"],
        intro.length + a.length
      );
      expect(out).toEqual([intro, a]);
    });
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
