import MarkdownIt from "markdown-it";
import {
  type Block,
  BlockSplitter,
  blockToMarkdown,
  splitBlocks,
} from "./blocks";

const cite = (sourceIndex: number, quote = "quoted text") => ({
  sourceIndex,
  sectionIndex: 0,
  endSectionIndex: 1,
  quote,
});

const SAMPLE = [
  "Intro paragraph line one.",
  "Line two of the intro.",
  "",
  "## Overview",
  "",
  "- First item",
  "  - Nested item",
  "    continued here",
  "2. Numbered `npm run build` step",
  "",
  "| Plan | Days |",
  "| --- | :---: |",
  "| Basic | 25 |",
  "| Pro | 30 |",
  "",
  "```bash",
  "yarn install",
  "  yarn build  ",
  "```",
  "Closing paragraph.",
].join("\n");

describe("splitBlocks", () => {
  it("splits every block class", () => {
    const blocks = splitBlocks(SAMPLE);
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ["paragraph", "Intro paragraph line one.\nLine two of the intro."],
      ["heading", "Overview"],
      ["listItem", "First item"],
      ["listItem", "Nested item\ncontinued here"],
      ["listItem", "Numbered `npm run build` step"],
      ["tableHeader", "Plan | Days"],
      ["tableRow", "Basic | 25"],
      ["tableRow", "Pro | 30"],
      ["code", "yarn install\n  yarn build  "],
      ["paragraph", "Closing paragraph."],
    ]);
    expect(blocks[1].level).toEqual(2);
    expect(blocks[3].level).toEqual(1);
    expect(blocks[4].marker).toEqual("2.");
    expect(blocks[4].inlineCode).toEqual(["npm run build"]);
    expect(blocks[6].cells).toEqual(["Basic", "25"]);
    expect(blocks[8].marker).toEqual("bash");
    expect(blocks.map((b) => b.tableId)).toEqual([
      0, 0, 0, 0, 0, 1, 1, 1, 0, 0,
    ]);
  });

  it("numbers each table", () => {
    expect(
      splitBlocks("| a |\n|---|\n| 1 |\n\n| b |\n|---|\n| 2 |").map(
        (b) => b.tableId
      )
    ).toEqual([1, 1, 2, 2]);
  });

  it("treats pipe lines without a separator row as a paragraph", () => {
    expect(
      splitBlocks("| not | a table |\nstill text").map((b) => b.kind)
    ).toEqual(["paragraph"]);
  });

  it("closes an unterminated code fence at the end", () => {
    const blocks = splitBlocks("```\nrm -rf build");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "code", text: "rm -rf build" });
  });

  it("ends a table at the first line that is not a row", () => {
    expect(
      splitBlocks("| a | b |\n|---|---|\n| 1 | 2 |\nafter").map((b) => b.kind)
    ).toEqual(["tableHeader", "tableRow", "paragraph"]);
  });
});

describe("BlockSplitter", () => {
  it("returns a block only once it is complete", () => {
    const splitter = new BlockSplitter();
    expect(splitter.push("First sentence")).toEqual([]);
    expect(splitter.push(" goes on.\n")).toEqual([]);
    const done = splitter.push("\n## Next");
    expect(done.map((b) => b.text)).toEqual(["First sentence goes on."]);
    expect(splitter.push("\n").map((b) => b.text)).toEqual(["Next"]);
    expect(splitter.flush()).toEqual([]);
  });

  it("drops citations of whitespace-only chunks", () => {
    const splitter = new BlockSplitter();
    const blocks = [
      ...splitter.push("Intro.\n"),
      ...splitter.push("\n", [cite(0)]),
      ...splitter.push(" ", [cite(1)]),
      ...splitter.push("Claim.\n\n"),
      ...splitter.flush(),
    ];
    expect(blocks.map((b) => [b.text, b.citations])).toEqual([
      ["Intro.", []],
      ["Claim.", []],
    ]);
  });

  it("does not carry a citation across a paragraph boundary", () => {
    const splitter = new BlockSplitter();
    const blocks = [
      ...splitter.push("Leave is 25 days.\n\nAlso", [cite(1)]),
      ...splitter.push(" employees get 3 sick days.\n\n", []),
      ...splitter.flush(),
    ];
    expect(blocks.map((b) => [b.text, b.citations])).toEqual([
      ["Leave is 25 days.", [cite(1)]],
      ["Also employees get 3 sick days.", []],
    ]);
  });

  it("attaches a citation that arrives on the last chunk of a sentence", () => {
    const splitter = new BlockSplitter();
    const blocks = [
      ...splitter.push("Intro.\n\nLeave ", []),
      ...splitter.push("is 25 ", []),
      ...splitter.push("days.", [cite(2)]),
      ...splitter.push("\n\nNext.", []),
      ...splitter.flush(),
    ];
    expect(blocks.map((b) => [b.text, b.citations])).toEqual([
      ["Intro.", []],
      ["Leave is 25 days.", [cite(2)]],
      ["Next.", []],
    ]);
  });

  it("attaches a chunk's citation to text after leading newlines", () => {
    const splitter = new BlockSplitter();
    const blocks = [
      ...splitter.push("Intro.", []),
      ...splitter.push("\n\nCited claim.", [cite(3)]),
      ...splitter.flush(),
    ];
    expect(blocks.map((b) => [b.text, b.citations])).toEqual([
      ["Intro.", []],
      ["Cited claim.", [cite(3)]],
    ]);
  });

  it("attaches citations on fence and separator lines", () => {
    const splitter = new BlockSplitter();
    const blocks = [
      ...splitter.push("| a |\n"),
      ...splitter.push("|---|\n", [cite(0)]),
      ...splitter.push("\n```\nyarn build\n"),
      ...splitter.push("```\n", [cite(1)]),
      ...splitter.flush(),
    ];
    expect(blocks.map((b) => b.citations)).toEqual([[cite(0)], [cite(1)]]);
  });

  it("matches the one-shot split for random chunkings", () => {
    const expected = splitBlocks(SAMPLE);
    // Which line each character is on, and which lines form each block
    // (found by pushing one line at a time, cited with its line number).
    const lineOf = [...SAMPLE].map(
      (_, i) => SAMPLE.slice(0, i).split("\n").length - 1
    );
    const byLine = new BlockSplitter();
    const lineBlocks = [
      ...SAMPLE.split("\n").flatMap((line, i) =>
        byLine.push(`${line}\n`, [cite(i)])
      ),
      ...byLine.flush(),
    ];
    const blockLines = lineBlocks.map(
      (b) => new Set(b.citations.map((c) => c.sourceIndex))
    );
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let run = 0; run < 200; run++) {
      const splitter = new BlockSplitter();
      const blocks: Block[] = [];
      // Lines of SAMPLE each chunk put non-whitespace text on.
      const chunkLines: Set<number>[] = [];
      let at = 0;
      while (at < SAMPLE.length) {
        // Some chunks are newline-only, as between provider content blocks.
        const size = 1 + Math.floor(random() * 12);
        const start = at;
        const text =
          SAMPLE[at] === "\n" && random() < 0.5
            ? SAMPLE.slice(at, (at += 1))
            : SAMPLE.slice(at, (at += size));
        const lines = new Set<number>();
        for (let i = start; i < Math.min(at, SAMPLE.length); i++) {
          if (SAMPLE[i].trim()) {
            lines.add(lineOf[i]);
          }
        }
        chunkLines.push(lines);
        blocks.push(...splitter.push(text, [cite(chunkLines.length - 1)]));
      }
      blocks.push(...splitter.flush());
      const plain = (list: Block[]) =>
        list.map((b) => ({ ...b, citations: [] }));
      expect(plain(blocks)).toEqual(plain(expected));
      // A block's citations come only from chunks that put text on its lines.
      blocks.forEach((b, i) => {
        const own = blockLines[i];
        for (const c of b.citations) {
          expect([...chunkLines[c.sourceIndex]].some((l) => own.has(l))).toBe(
            true
          );
        }
        const ids = b.citations.map((c) => c.sourceIndex);
        expect(new Set(ids).size).toEqual(ids.length);
      });
    }
  });

  it("attaches the citations of the text that formed each block", () => {
    const splitter = new BlockSplitter();
    const blocks = [
      ...splitter.push("Intro.\n\n"),
      ...splitter.push("Cited claim.", [cite(0)]),
      ...splitter.push("\n\n- item ", [cite(1)]),
      ...splitter.push("more", [cite(1)]),
      ...splitter.flush(),
    ];
    expect(blocks.map((b) => [b.text, b.citations])).toEqual([
      ["Intro.", []],
      ["Cited claim.", [cite(0)]],
      ["item more", [cite(1)]],
    ]);
  });
});

describe("blockToMarkdown", () => {
  it("renders safe Markdown for each block class", () => {
    expect(splitBlocks(SAMPLE).map(blockToMarkdown)).toEqual([
      "Intro paragraph line one.\nLine two of the intro.",
      "## Overview",
      "- First item",
      "- Nested item\n  continued here",
      "2. Numbered `npm run build` step",
      "| Plan | Days |\n| --- | --- |",
      "| Basic | 25 |",
      "| Pro | 30 |",
      "```bash\nyarn install\n  yarn build  \n```",
      "Closing paragraph.",
    ]);
  });

  it("escapes line starts that would open another block", () => {
    const [block] = splitBlocks("Text");
    expect(
      blockToMarkdown({ ...block, text: "```js x\n# y\n- z\n**bold** ok" })
    ).toEqual("\\`\\`\\`js x\n\\# y\n\\- z\n**bold** ok");
  });

  it("escapes characters that could form links, images or HTML", () => {
    const [block] = splitBlocks("Text");
    expect(
      blockToMarkdown({
        ...block,
        text: "a [b](c) ![d] <e> f\\g `[k](l) <m>` stray `",
      })
    ).toEqual("a \\[b\\](c) \\!\\[d\\] \\<e\\> f\\\\g `[k](l) <m>` stray \\`");
  });

  it("escapes table cells, keeping escaped pipes inside a cell", () => {
    const [, row] = splitBlocks("| a |\n|---|\n| [x](y) a\\|b |");
    expect(row.cells).toEqual(["[x](y) a\\|b"]);
    expect(blockToMarkdown(row)).toEqual("| \\[x\\](y) a\\\\\\|b |");
  });

  it.each([
    ["trailing backslash", ["x\\", "[a](b)"], ["x\\", "[a](b)"]],
    ["backslash before pipe", ["a\\|b", "c\\\\|d"], ["a\\|b", "c\\\\|d"]],
    ["pipe inside a code span", ["`a|b`", "<i>"], ["a|b", "<i>"]],
    ["backslash inside a code span", ["`a\\`", "![i](j)"], ["a\\", "![i](j)"]],
    ["backslash and pipe inside a code span", ["`a\\|b`", "z"], ["a\\|b", "z"]],
    ["code span then trailing backslash", ["`a` \\", "<b>"], ["a \\", "<b>"]],
  ])(
    "round-trips a table cell with a %s through markdown-it",
    (_label, cells, expected) => {
      const [block] = splitBlocks("Text");
      const header = blockToMarkdown({ ...block, kind: "tableHeader", cells });
      const tokens = new MarkdownIt("default", {
        html: false,
        linkify: false,
      }).parse(header, {});
      const inline = tokens.filter((t) => t.type === "inline");
      const children = inline.flatMap((t) => t.children ?? []);

      expect(tokens.filter((t) => t.type === "th_open")).toHaveLength(
        cells.length
      );
      expect(tokens.filter((t) => t.type === "tr_open")).toHaveLength(1);
      expect(
        inline.map((t) => (t.children ?? []).map((c) => c.content).join(""))
      ).toEqual(expected);
      expect(
        children.filter((c) =>
          ["link_open", "image", "html_inline"].includes(c.type)
        )
      ).toEqual([]);
    }
  );

  it("uses a fence longer than any backtick run in the code", () => {
    const [block] = splitBlocks("~~~\na ``` b\n~~~");
    expect(blockToMarkdown(block)).toEqual("````\na ``` b\n````");
  });
});
