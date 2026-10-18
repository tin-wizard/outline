import type { Turn } from "./model";
import {
  answerParts,
  coverageOf,
  followUpSuggestions,
  gapBlocks,
  isGapBlock,
  isNotCovered,
  verificationOf,
} from "./answerInsights";

const cite = (n: number, url: string) => ({
  n,
  documentId: `d${n}`,
  title: `Doc ${n}`,
  url,
});

function turn(over: Partial<Turn> = {}): Turn {
  return {
    id: 1,
    question: "Q?",
    scope: {},
    status: "done",
    sources: [
      { n: 1, documentId: "d1", title: "Doc 1", url: "/doc/a" },
      { n: 2, documentId: "d2", title: "Doc 2", url: "/doc/b" },
      { n: 3, documentId: "d3", title: "Doc 3", url: "/doc/c" },
    ],
    blocks: [
      {
        index: 0,
        kind: "paragraph",
        markdown: "Claim [1] [2].",
        citations: [cite(1, "/doc/a#h-leave-policy"), cite(2, "/doc/b#h-pay")],
      },
    ],
    ...over,
  };
}

const gap = (index: number) => ({
  index,
  kind: "paragraph" as const,
  markdown: "The documents do not cover contractors.",
  citations: [],
});

describe("verificationOf", () => {
  it("reports the cited sources and that every statement is cited", () => {
    expect(verificationOf(turn())).toEqual({
      state: "verified",
      cited: 2,
      everyCited: true,
    });
  });

  it("does not claim every statement cited next to an uncited gap statement", () => {
    expect(
      verificationOf(turn({ blocks: [...turn().blocks, gap(1)] }))
    ).toEqual({
      state: "verified",
      cited: 2,
      everyCited: false,
    });
  });

  it("ignores headings when judging whether every statement is cited", () => {
    const heading = {
      index: 1,
      kind: "heading" as const,
      markdown: "Overview",
      citations: [],
    };
    expect(
      verificationOf(turn({ blocks: [heading, ...turn().blocks] }))
    ).toMatchObject({ everyCited: true });
  });

  it("is partial for failed or stopped turns that kept blocks", () => {
    expect(verificationOf(turn({ problem: "unverified" }))).toEqual({
      state: "partial",
    });
    expect(verificationOf(turn({ status: "stopped" }))).toEqual({
      state: "partial",
    });
  });

  it("is verified only when nothing was dropped", () => {
    expect(verificationOf(turn({ droppedSegments: 0 }))?.state).toBe(
      "verified"
    );
    expect(verificationOf(turn({ droppedSegments: 2 }))).toEqual({
      state: "trimmed",
    });
  });

  it("claims nothing while streaming or without blocks", () => {
    expect(verificationOf(turn({ status: "generating" }))).toBeUndefined();
    expect(verificationOf(turn({ blocks: [] }))).toBeUndefined();
  });
});

describe("isNotCovered", () => {
  it("is true for no_answer", () => {
    expect(isNotCovered(turn({ problem: "no_answer", blocks: [] }))).toBe(true);
  });

  it("is true for an uncited gap statement", () => {
    const gap = turn({
      blocks: [
        {
          index: 0,
          kind: "paragraph",
          markdown: "The documents do not cover parental leave.",
          citations: [],
        },
      ],
    });
    expect(isNotCovered(gap)).toBe(true);
  });

  it("is false for cited answers and other failures", () => {
    expect(isNotCovered(turn())).toBe(false);
    expect(isNotCovered(turn({ problem: "timeout", blocks: [] }))).toBe(false);
    expect(isNotCovered(turn({ status: "searching", blocks: [] }))).toBe(false);
  });
});

describe("followUpSuggestions", () => {
  it("builds heading chips and a compare chip", () => {
    expect(followUpSuggestions(turn())).toEqual([
      { kind: "more", heading: "leave policy" },
      { kind: "more", heading: "pay" },
      { kind: "compare" },
    ]);
  });

  it("prefers the server heading over the anchor label", () => {
    const t = turn({
      blocks: [
        {
          index: 0,
          kind: "paragraph",
          markdown: "x",
          citations: [
            { ...cite(1, "/doc/a#h-overview-1"), heading: "Overview" },
            cite(2, "/doc/b#h-pay"),
          ],
        },
      ],
    });
    expect(followUpSuggestions(t).slice(0, 2)).toEqual([
      { kind: "more", heading: "Overview" },
      { kind: "more", heading: "pay" },
    ]);
  });

  it("caps headings at three, deduplicated", () => {
    const t = turn({
      blocks: [1, 2, 3, 4, 5].map((n) => ({
        index: n,
        kind: "paragraph" as const,
        markdown: "x",
        citations: [
          cite(1, `/doc/a#h-${n === 5 ? "h1" : `h${n}`}`),
          cite(1, "/doc/a#h-H1"),
        ],
      })),
    });
    const more = followUpSuggestions(t).filter((f) => f.kind === "more");
    expect(more).toHaveLength(3);
    expect(followUpSuggestions(t).some((f) => f.kind === "compare")).toBe(
      false
    );
  });

  it("has no chips for unfinished, failed or uncited answers", () => {
    expect(followUpSuggestions(turn({ status: "generating" }))).toEqual([]);
    expect(followUpSuggestions(turn({ problem: "unverified" }))).toEqual([]);
    expect(
      followUpSuggestions(
        turn({
          blocks: [
            { index: 0, kind: "paragraph", markdown: "x", citations: [] },
          ],
        })
      )
    ).toEqual([]);
  });
});

describe("coverageOf", () => {
  it("counts the released cited claim blocks and the cited documents", () => {
    const blocks = [
      ...turn().blocks,
      {
        index: 1,
        kind: "listItem" as const,
        markdown: "Another.",
        citations: [cite(1, "/doc/a#h-leave-policy")],
      },
      { index: 2, kind: "heading" as const, markdown: "H", citations: [] },
    ];
    expect(coverageOf(turn({ blocks }))).toEqual({
      kind: "all",
      statements: 2,
      documents: 2,
    });
  });

  it("never says all statements match when something was dropped", () => {
    expect(coverageOf(turn({ droppedSegments: 1 }))).toEqual({
      kind: "dropped",
    });
  });

  it("is the calm gap variant when a gap statement is present", () => {
    expect(coverageOf(turn({ blocks: [...turn().blocks, gap(1)] }))).toEqual({
      kind: "gap",
    });
  });

  it("is partial for a failed turn and absent while streaming or without blocks", () => {
    expect(coverageOf(turn({ problem: "unverified" }))).toEqual({
      kind: "partial",
    });
    expect(coverageOf(turn({ status: "generating" }))).toBeUndefined();
    expect(coverageOf(turn({ blocks: [] }))).toBeUndefined();
    expect(
      coverageOf(turn({ blocks: [gap(0)] })) // fully not covered: the notice speaks
    ).toBeUndefined();
  });
});

describe("gap statements", () => {
  it("detects the verifier's lead only on uncited paragraphs", () => {
    expect(isGapBlock(gap(0))).toBe(true);
    expect(isGapBlock({ ...gap(0), citations: [cite(1, "/doc/a")] })).toBe(
      false
    );
    expect(isGapBlock({ ...gap(0), kind: "listItem" })).toBe(false);
    expect(
      isGapBlock({ ...gap(0), markdown: "Documents are great and do not rot." })
    ).toBe(false);
  });

  it("splits an answer around gap statements, or leaves them out", () => {
    const blocks = [
      ...turn().blocks,
      gap(1),
      { ...turn().blocks[0], index: 2 },
    ];
    const t = turn({ blocks });
    expect(answerParts(t).map((p) => p.type)).toEqual([
      "blocks",
      "gap",
      "blocks",
    ]);
    expect(answerParts(t, true).map((p) => p.type)).toEqual([
      "blocks",
      "blocks",
    ]);
    expect(gapBlocks(t)).toHaveLength(1);
  });
});
