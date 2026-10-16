import { BlockSplitter, blockToMarkdown, splitBlocks } from "./blocks";

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

  it("matches the one-shot split for random chunkings", () => {
    const expected = splitBlocks(SAMPLE);
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let run = 0; run < 200; run++) {
      const splitter = new BlockSplitter();
      const blocks = [];
      let at = 0;
      while (at < SAMPLE.length) {
        const size = 1 + Math.floor(random() * 12);
        blocks.push(...splitter.push(SAMPLE.slice(at, at + size)));
        at += size;
      }
      blocks.push(...splitter.flush());
      expect(blocks).toEqual(expected);
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
    ).toEqual("\\```js x\n\\# y\n\\- z\n**bold** ok");
  });

  it("uses a fence longer than any backtick run in the code", () => {
    const [block] = splitBlocks("~~~\na ``` b\n~~~");
    expect(blockToMarkdown(block)).toEqual("````\na ``` b\n````");
  });
});
