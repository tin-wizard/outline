import { groupBlocks, parseInline } from "./markdown";
import type { BlockInput } from "./markdown";

const time = (fn: () => void) => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};

describe("parseInline performance", () => {
  const N = 16_000;
  it.each([
    ["*a ", "*a ".repeat(N / 3)],
    ["_a ", "_a ".repeat(N / 3)],
    ["**a ", "**a ".repeat(N / 4)],
    ["nested *x ", "*x ".repeat(N / 3) + "*x* ".repeat(10)],
    ["mixed", "*a _b **c ".repeat(N / 10)],
    ["unclosed code", "`a ".repeat(N / 3)],
  ])("stays linear for %s", (_name, input) => {
    expect(time(() => parseInline(input))).toBeLessThan(50);
  });

  it("still matches emphasis after an earlier unmatched marker", () => {
    expect(parseInline("2 * 3 and *real*")).toEqual([
      { type: "text", value: "2 * 3 and " },
      { type: "em", children: [{ type: "text", value: "real" }] },
    ]);
  });
});

describe("groupBlocks caching", () => {
  const block = (markdown: string): BlockInput => ({
    kind: "paragraph",
    markdown,
    citations: [],
  });

  it("does not re-parse earlier blocks when a block is appended", () => {
    const a = block("**one**");
    const b = block("two");
    const first = groupBlocks([a]);
    const second = groupBlocks([a, b]);
    expect(second).toHaveLength(2);
    const g0 = first[0];
    const g1 = second[0];
    if (g0.type !== "paragraph" || g1.type !== "paragraph") {
      throw new Error("expected paragraphs");
    }
    // Same parsed object: the earlier block was served from the cache.
    expect(g1.item).toBe(g0.item);
  });

  it("does not let grouping mutate cached items", () => {
    const header: BlockInput = {
      kind: "tableHeader",
      markdown: "| a |\n| --- |",
      citations: [],
    };
    const row: BlockInput = {
      kind: "tableRow",
      markdown: "| 1 |",
      citations: [],
    };
    const once = groupBlocks([header, row]);
    const twice = groupBlocks([header, row]);
    expect(twice).toEqual(once);
    expect(groupBlocks([header])[0]).toMatchObject({ rows: [] });
  });
});
