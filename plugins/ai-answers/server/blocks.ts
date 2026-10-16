import type { ProviderCitation } from "./contract";

/** The kinds of Markdown block an answer may be made of. */
export type BlockKind =
  | "paragraph"
  | "heading"
  | "listItem"
  | "tableHeader"
  | "tableRow"
  | "code";

/** One verifiable unit of a Markdown answer. */
export interface Block {
  kind: BlockKind;
  /**
   * The visible text: markers removed, lines joined with "\n", table cells
   * joined with " | ", and the raw contents for a code block.
   */
  text: string;
  /** Heading level (1-6) or list nesting depth (0 = top level); 0 otherwise. */
  level: number;
  /** List marker ("-", "2.") or code fence info string; empty otherwise. */
  marker: string;
  /** Table cells of a header or body row; empty otherwise. */
  cells: string[];
  /** Inline code spans in the text; empty for code blocks. */
  inlineCode: string[];
  /** Citations the provider attached to any text that formed this block. */
  citations: ProviderCitation[];
}

/**
 * Splits Markdown text into blocks incrementally, so blocks can be verified
 * and released while the model is still writing. Nested list items are
 * flattened into one block each, and every table row is its own block.
 */
export class BlockSplitter {
  /**
   * Adds generated text and the citations attached to it.
   *
   * @param text the next piece of generated text.
   * @param citations citations for this piece; they attach to every block it touches.
   * @returns the blocks completed by this piece, in order.
   */
  public push(text: string, citations: ProviderCitation[] = []): Block[] {
    const out: Block[] = [];
    const pieces = text.split("\n");
    pieces.forEach((piece, i) => {
      if (piece) {
        this.partial += piece;
        this.partialCitations.push(...citations);
      }
      if (i < pieces.length - 1) {
        this.endLine(out);
      }
    });
    return out;
  }

  /**
   * Ends the text, completing whatever block is still open.
   *
   * @returns the remaining blocks, in order.
   */
  public flush(): Block[] {
    const out: Block[] = [];
    if (this.partial) {
      this.endLine(out);
    }
    if (this.fence) {
      out.push(this.codeBlock());
    }
    this.close(out);
    return out;
  }

  private partial = "";
  private partialCitations: ProviderCitation[] = [];
  private open?: OpenBlock;
  private fence?: { char: string; length: number; info: string } & Lines;
  private inTable = false;

  private endLine(out: Block[]) {
    const line = this.partial.replace(/\r$/, "");
    const citations = this.partialCitations;
    this.partial = "";
    this.partialCitations = [];
    this.line(line, citations, out);
  }

  private line(raw: string, citations: ProviderCitation[], out: Block[]) {
    if (this.fence) {
      const close = raw.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (
        close &&
        close[1][0] === this.fence.char &&
        close[1].length >= this.fence.length
      ) {
        out.push(this.codeBlock());
        return;
      }
      this.fence.lines.push(raw);
      this.fence.citations.push(...citations);
      return;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      this.close(out);
      this.inTable = false;
      return;
    }
    if (this.inTable && trimmed.startsWith("|")) {
      out.push(block("tableRow", cellsOf(trimmed), citations));
      return;
    }
    this.inTable = false;
    if (this.open?.maybeTable && isSeparator(trimmed)) {
      const cells = cellsOf(this.open.lines[0]);
      out.push(block("tableHeader", cells, this.open.citations));
      this.open = undefined;
      this.inTable = true;
      return;
    }

    const fence = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      this.close(out);
      this.fence = {
        char: fence[1][0],
        length: fence[1].length,
        info: fence[2].trim(),
        lines: [],
        citations: [...citations],
      };
      return;
    }
    const heading = raw.match(
      /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
    );
    if (heading) {
      this.close(out);
      out.push({
        ...block("heading", heading[2] ?? "", citations),
        level: heading[1].length,
      });
      return;
    }
    const item = raw.match(/^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/);
    if (item) {
      this.close(out);
      this.open = {
        kind: "listItem",
        level: Math.floor(item[1].replace(/\t/g, "  ").length / 2),
        marker: item[2],
        lines: [item[3].trim()],
        citations: [...citations],
      };
      return;
    }
    if (trimmed.startsWith("|")) {
      this.close(out);
      this.open = {
        kind: "paragraph",
        level: 0,
        marker: "",
        lines: [trimmed],
        citations: [...citations],
        maybeTable: true,
      };
      return;
    }
    if (this.open) {
      this.open.lines.push(trimmed);
      this.open.citations.push(...citations);
      this.open.maybeTable = false;
      return;
    }
    this.open = {
      kind: "paragraph",
      level: 0,
      marker: "",
      lines: [trimmed],
      citations: [...citations],
    };
  }

  private close(out: Block[]) {
    if (!this.open) {
      return;
    }
    const { kind, level, marker, lines, citations } = this.open;
    this.open = undefined;
    out.push({ ...block(kind, lines.join("\n"), citations), level, marker });
  }

  private codeBlock(): Block {
    const fence = this.fence;
    this.fence = undefined;
    return {
      ...block("code", fence?.lines.join("\n") ?? "", fence?.citations ?? []),
      marker: fence?.info ?? "",
      inlineCode: [],
    };
  }
}

/**
 * Splits a complete Markdown answer into blocks.
 *
 * @param markdown the whole answer.
 * @returns its blocks, in order.
 */
export function splitBlocks(markdown: string): Block[] {
  const splitter = new BlockSplitter();
  return [...splitter.push(markdown), ...splitter.flush()];
}

/**
 * Renders a block as standalone Markdown. Nested list items come out
 * flattened, table alignment is dropped, and a header row includes its
 * separator row. Table rows must be joined to their header with a single
 * newline; other blocks with a blank line.
 *
 * @param block the block to render, normally one returned by `verifyBlock`.
 * @returns the Markdown for the block.
 */
export function blockToMarkdown(block: Block): string {
  switch (block.kind) {
    case "heading":
      return `${"#".repeat(Math.min(Math.max(block.level, 1), 6))} ${block.text}`;
    case "listItem": {
      const marker = /^\d/.test(block.marker)
        ? `${parseInt(block.marker, 10)}.`
        : "-";
      const indent = " ".repeat(marker.length + 1);
      return `${marker} ${escapeLineStarts(block.text).split("\n").join(`\n${indent}`)}`;
    }
    case "tableHeader":
      return `${row(block.cells)}\n${row(block.cells.map(() => "---"))}`;
    case "tableRow":
      return row(block.cells);
    case "code": {
      const longest = Math.max(
        2,
        ...[...block.text.matchAll(/`+/g)].map((m) => m[0].length)
      );
      const fence = "`".repeat(longest + 1);
      return `${fence}${block.marker}\n${block.text}\n${fence}`;
    }
    default:
      return escapeLineStarts(block.text);
  }
}

interface Lines {
  lines: string[];
  citations: ProviderCitation[];
}

interface OpenBlock extends Lines {
  kind: "paragraph" | "listItem";
  level: number;
  marker: string;
  /** A single pipe line that becomes a table header if a separator follows. */
  maybeTable?: boolean;
}

function block(
  kind: BlockKind,
  content: string | string[],
  citations: ProviderCitation[]
): Block {
  const cells = Array.isArray(content) ? content : [];
  const text = Array.isArray(content) ? content.join(" | ") : content;
  return {
    kind,
    text,
    level: 0,
    marker: "",
    cells,
    inlineCode: [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
    citations: dedupe(citations),
  };
}

function dedupe(citations: ProviderCitation[]): ProviderCitation[] {
  const seen = new Map<string, ProviderCitation>();
  for (const c of citations) {
    seen.set(
      `${c.sourceIndex}:${c.sectionIndex}:${c.endSectionIndex}:${c.quote}`,
      c
    );
  }
  return [...seen.values()];
}

function cellsOf(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

function isSeparator(line: string): boolean {
  return line.includes("|") && cellsOf(line).every((c) => /^:?-+:?$/.test(c));
}

/** Escapes line starts that would open another block (heading, list, fence, quote, table). */
function escapeLineStarts(text: string): string {
  return text.replace(
    /^(\s*)(?=#|>|\||`{3}|~{3}|[-+*][ \t]|\d+[.)][ \t]|(?:=+|-+)\s*$)/gm,
    "$1\\"
  );
}

function row(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}
