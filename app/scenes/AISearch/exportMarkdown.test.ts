import type { Turn } from "./model";
import {
  conversationToMarkdown,
  escapeMarkdown,
  exportFilename,
  turnToMarkdown,
} from "./exportMarkdown";

const ORIGIN = "https://wiki.example.com";
const both = { includeQuestion: true, includeSources: true, origin: ORIGIN };

function make(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 1,
    question: "How do I take leave?",
    scope: {},
    status: "done",
    sources: null,
    blocks: [
      {
        index: 0,
        kind: "paragraph",
        markdown: "Ask your manager [1].",
        citations: [
          {
            n: 1,
            documentId: "d1",
            title: "Leave policy",
            url: "/doc/leave-abc#h-requests",
            quote: "Requests go to managers.",
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("turnToMarkdown", () => {
  it("serializes a single turn with sources (golden)", () => {
    expect(turnToMarkdown(make(), both)).toBe(
      [
        "> How do I take leave?",
        "",
        "Ask your manager [1].",
        "",
        "Sources",
        "",
        "1. [Leave policy](https://wiki.example.com/doc/leave-abc#h-requests)",
      ].join("\n")
    );
  });

  it("omits question and sources when asked", () => {
    expect(
      turnToMarkdown(make(), { includeQuestion: false, includeSources: false })
    ).toBe("Ask your manager [1].");
  });

  it("keeps block markdown verbatim and tight for lists and tables", () => {
    const blocks: Turn["blocks"] = [
      { index: 0, kind: "heading", markdown: "## Steps", citations: [] },
      { index: 1, kind: "listItem", markdown: "- a \\[x\\]", citations: [] },
      { index: 2, kind: "listItem", markdown: "- b", citations: [] },
      {
        index: 3,
        kind: "tableHeader",
        markdown: "| h |\n| - |",
        citations: [],
      },
      { index: 4, kind: "tableRow", markdown: "| 1 |", citations: [] },
    ];
    expect(
      turnToMarkdown(make({ blocks }), {
        includeQuestion: false,
        includeSources: false,
      })
    ).toBe("## Steps\n\n- a \\[x\\]\n- b\n\n| h |\n| - |\n| 1 |");
  });

  it("marks partial and failed turns", () => {
    expect(
      turnToMarkdown(make({ status: "failed", problem: "timeout" }), both)
    ).toContain("\n\nNot fully verified\n\n");
    const empty = turnToMarkdown(
      make({ status: "failed", problem: "error", blocks: [] }),
      both
    );
    expect(empty).toBe("> How do I take leave?\n\nNot fully verified");
  });

  it("skips sources whose path is not a document path", () => {
    const turn = make();
    turn.blocks[0].citations[0].url = "javascript:alert(1)";
    expect(turnToMarkdown(turn, both)).not.toContain("Sources");
    expect(turnToMarkdown(turn, both)).not.toContain("javascript");
  });

  it("builds source URLs from the injected origin", () => {
    expect(
      turnToMarkdown(make(), { ...both, origin: "http://localhost:3000" })
    ).toContain("(http://localhost:3000/doc/leave-abc#h-requests)");
  });

  it("does not let a title break out of the link", () => {
    const turn = make();
    turn.blocks[0].citations[0].title = "[x](javascript:alert(1)) `]` ) <b>";
    const md = turnToMarkdown(turn, both);
    const line = md.split("\n").pop() ?? "";
    expect(line).toBe(
      "1. [\\[x\\]\\(javascript:alert\\(1\\)\\) \\`\\]\\` \\) \\<b\\>](https://wiki.example.com/doc/leave-abc#h-requests)"
    );
  });

  it("percent-encodes characters that end a link destination", () => {
    const turn = make();
    turn.blocks[0].citations[0].url = "/doc/a-b#h-x(1)<y>";
    expect(turnToMarkdown(turn, both)).toContain(
      "(https://wiki.example.com/doc/a-b#h-x%281%29%3Cy%3E)"
    );
  });

  it.each([
    "[x](javascript:alert(1))",
    "<img src=x onerror=alert(1)>",
    "# heading\n- list\n1. item\n> quote",
    "`code` and *bold* and https://evil.example",
  ])("keeps question %j literal", (question) => {
    const md = turnToMarkdown(make({ question, blocks: [] }), {
      includeQuestion: true,
      includeSources: false,
    });
    // no unescaped markup characters
    expect(md).not.toMatch(/(^|[^\\])[<[`*]/);
    expect(md).not.toMatch(/\]\(/);
    for (const line of md.split("\n")) {
      expect(line.startsWith("> ")).toBe(true);
      expect(line.slice(2)).not.toMatch(/^(#|-|\+|\d+\.)/);
    }
  });
});

describe("hidden blocks", () => {
  it("leaves a plain line where a block is withheld", () => {
    const base = make();
    const turn = make({
      hiddenBlocks: [1],
      blocks: [
        base.blocks[0],
        { index: 2, kind: "paragraph", markdown: "After.", citations: [] },
      ],
    });
    expect(
      turnToMarkdown(turn, {
        ...both,
        includeQuestion: false,
        includeSources: false,
      })
    ).toBe(
      "Ask your manager [1].\n\n_(A part of this answer is no longer available.)_\n\nAfter."
    );
  });

  it("emits one line for adjacent hidden blocks", () => {
    const turn = make({ hiddenBlocks: [1, 2], blocks: make().blocks });
    const md = turnToMarkdown(turn, { ...both, includeSources: false });
    expect(md.match(/no longer available/g)).toHaveLength(1);
  });
});

describe("conversationToMarkdown", () => {
  it("joins turns under an escaped title (golden)", () => {
    const second = make({
      id: 2,
      question: "And sick leave?",
      blocks: [
        { index: 0, kind: "paragraph", markdown: "Same.", citations: [] },
      ],
    });
    expect(
      conversationToMarkdown([make(), second], {
        title: "AI [Search]",
        origin: ORIGIN,
      })
    ).toBe(
      [
        "# AI \\[Search\\]",
        "",
        turnToMarkdown(make(), both),
        "",
        "---",
        "",
        "> And sick leave?",
        "",
        "Same.",
        "",
      ].join("\n")
    );
  });
});

describe("escapeMarkdown", () => {
  it("drops bidi and control characters", () => {
    expect(escapeMarkdown("a‮b\u0000c")).toBe("abc");
  });
});

describe("exportFilename", () => {
  const date = new Date("2026-10-18T12:00:00Z");
  it.each([
    [
      "How do we onboard a new team member?",
      "ai-search-how-do-we-onboard-a-new-team-member-2026-10-18.md",
    ],
    ["Ünïcödé ../../etc/passwd", "ai-search-unicode-etc-passwd-2026-10-18.md"],
    ["日本語", "ai-search-2026-10-18.md"],
    ["", "ai-search-2026-10-18.md"],
  ])("%j", (question, expected) => {
    expect(exportFilename(question, date)).toBe(expected);
  });

  it("limits length and stays ASCII", () => {
    const name = exportFilename("word ".repeat(40), date);
    expect(name).toMatch(/^[a-z0-9.-]+$/);
    expect(name.length).toBeLessThan(80);
  });
});
