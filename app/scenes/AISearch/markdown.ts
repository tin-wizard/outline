import type { AskCitation } from "~/utils/streamFetch";

/*
 * A deliberately tiny Markdown reader for the output of the server's
 * `blockToMarkdown` (plugins/ai-answers/server/blocks.ts). The server escapes
 * everything that could become a link, image, autolink or HTML and strips
 * model-written links, so the only constructs read here are the ones it
 * emits: headings, paragraphs, bold/italic, inline code, fenced code, flat
 * lists and tables. Anything else is plain text. The result is a data tree
 * that React renders as text nodes, so nothing is ever parsed as HTML, links
 * are never created and there is no dangerouslySetInnerHTML.
 */

export type Inline =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] };

/** One block event from the server, as stored by the page. */
export interface BlockInput {
  kind:
    | "paragraph"
    | "heading"
    | "listItem"
    | "tableHeader"
    | "tableRow"
    | "code";
  markdown: string;
  citations: AskCitation[];
}

export interface ParsedItem {
  inline: Inline[];
  /** Citation numbers shown as markers after the content. */
  citations: number[];
}

export type Group =
  | { type: "paragraph"; item: ParsedItem }
  | { type: "heading"; level: number; item: ParsedItem }
  | { type: "list"; ordered: boolean; start: number; items: ParsedItem[] }
  | { type: "table"; header: ParsedItem[]; rows: ParsedItem[][] }
  | { type: "code"; language: string; code: string; citations: number[] };

const PUNCTUATION = /[!-/:-@[-`{-~]/;

/**
 * Parses inline text: backslash escapes, `code`, **strong**, and *em* / _em_.
 * Unmatched markers stay literal. Never produces anything but text, code,
 * strong and em nodes.
 *
 * @param input the escaped inline Markdown.
 * @returns the inline tree.
 */
export function parseInline(input: string): Inline[] {
  const out: Inline[] = [];
  const exhausted = new Set<string>();
  let text = "";
  const flush = () => {
    if (text) {
      out.push({ type: "text", value: text });
      text = "";
    }
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i];

    if (ch === "\\" && i + 1 < input.length) {
      if (PUNCTUATION.test(input[i + 1])) {
        text += input[i + 1];
        i += 2;
        continue;
      }
    }

    if (ch === "`") {
      const end = input.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: "code", value: input.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      const double = input[i + 1] === ch;
      const marker = double ? ch + ch : ch;
      const prev = i > 0 ? input[i - 1] : " ";
      // Underscores inside words (snake_case) are literal.
      const wordInternal = ch === "_" && /[A-Za-z0-9]/.test(prev);
      // A marker whose scan already reached the end without a closer cannot
      // be closed by a later one, so later ones are literal. This keeps the
      // parse linear for inputs like "*a *a *a ...".
      const close =
        wordInternal || exhausted.has(marker)
          ? -1
          : findClosing(input, i + marker.length, marker);
      if (close === NO_CLOSER) {
        exhausted.add(marker);
      }
      if (close >= 0) {
        flush();
        const children = parseInline(input.slice(i + marker.length, close));
        out.push(
          double ? { type: "strong", children } : { type: "em", children }
        );
        i = close + marker.length;
        continue;
      }
    }

    text += ch;
    i++;
  }
  flush();
  return out;
}

/** Returned by findClosing when the whole rest of the input was scanned. */
const NO_CLOSER = -1;
/** Returned by findClosing when the opener is invalid without scanning. */
const NOT_AN_OPENER = -2;

/** Finds the closing marker for an emphasis run, skipping escapes and code spans. */
function findClosing(input: string, from: number, marker: string): number {
  // Content must start with a non-space character.
  if (from >= input.length || /\s/.test(input[from])) {
    return NOT_AN_OPENER;
  }
  let i = from;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = input.indexOf("`", i + 1);
      i = end === -1 ? i + 1 : end + 1;
      continue;
    }
    if (input.startsWith(marker, i) && i > from && !/\s/.test(input[i - 1])) {
      // A single marker must not be half of a double one.
      if (marker.length === 1 && input[i + 1] === marker) {
        i += 2;
        continue;
      }
      const next = input[i + marker.length];
      if (marker[0] === "_" && next !== undefined && /[A-Za-z0-9]/.test(next)) {
        i++;
        continue;
      }
      return i;
    }
    i++;
  }
  return NO_CLOSER;
}

/** Splits a table row on unescaped pipes. */
function splitCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

function citationNumbers(citations: AskCitation[]): number[] {
  return [...new Set(citations.map((c) => c.n))].sort((a, b) => a - b);
}

function item(markdown: string, citations: AskCitation[]): ParsedItem {
  return {
    inline: parseInline(markdown.replace(/\n\s*/g, "\n")),
    citations: citationNumbers(citations),
  };
}

type Parsed =
  | { type: "heading"; level: number; item: ParsedItem }
  | { type: "listItem"; ordered: boolean; start: number; item: ParsedItem }
  | { type: "tableHeader"; header: ParsedItem[] }
  | { type: "tableRow"; cells: ParsedItem[]; asText: ParsedItem }
  | { type: "code"; language: string; code: string; citations: number[] }
  | { type: "paragraph"; item: ParsedItem };

/** Parsed output per block object, so earlier blocks are not re-parsed as the answer grows. */
const parsedBlocks = new WeakMap<BlockInput, Parsed>();

function parseBlock(block: BlockInput): Parsed {
  const cached = parsedBlocks.get(block);
  if (cached) {
    return cached;
  }
  const parsed = parseBlockUncached(block);
  parsedBlocks.set(block, parsed);
  return parsed;
}

function parseBlockUncached(block: BlockInput): Parsed {
  switch (block.kind) {
    case "heading": {
      const match = /^(#{1,6})\s+([\s\S]*)$/.exec(block.markdown);
      return {
        type: "heading",
        level: match ? match[1].length : 1,
        item: item(match ? match[2] : block.markdown, block.citations),
      };
    }
    case "listItem": {
      const match = /^(?:(\d+)\.|-)\s+([\s\S]*)$/.exec(block.markdown);
      return {
        type: "listItem",
        ordered: !!match?.[1],
        start: match?.[1] ? parseInt(match[1], 10) : 1,
        item: item(match ? match[2] : block.markdown, block.citations),
      };
    }
    case "tableHeader": {
      const [headerLine] = block.markdown.split("\n");
      return {
        type: "tableHeader",
        header: splitCells(headerLine).map((cell) => item(cell, [])),
      };
    }
    case "tableRow": {
      const cells = splitCells(block.markdown).map((cell) => item(cell, []));
      const tail = cells[cells.length - 1];
      if (tail) {
        // Citations of a row go on its last cell.
        tail.citations = citationNumbers(block.citations);
      }
      return {
        type: "tableRow",
        cells,
        asText: {
          inline: [
            {
              type: "text",
              value: cells.map((c) => flatten(c.inline)).join(" | "),
            },
          ],
          citations: citationNumbers(block.citations),
        },
      };
    }
    case "code": {
      const lines = block.markdown.split("\n");
      const open = /^(`{3,}|~{3,})(.*)$/.exec(lines[0]);
      const hasClose =
        !!open &&
        lines.length > 1 &&
        lines[lines.length - 1].startsWith(open[1]);
      return {
        type: "code",
        language: open ? open[2].trim() : "",
        code: lines.slice(open ? 1 : 0, hasClose ? -1 : undefined).join("\n"),
        citations: citationNumbers(block.citations),
      };
    }
    default:
      return {
        type: "paragraph",
        item: item(block.markdown, block.citations),
      };
  }
}

/**
 * Groups streamed blocks into renderable structures: a table header joins the
 * rows that follow it, consecutive list items of the same kind form one list,
 * and everything else stands alone. A table row with no header is shown as a
 * paragraph of its cells. Each block is parsed once (cached per block object),
 * so calling this on every new block only parses the new one.
 *
 * @param blocks the blocks received so far, in order.
 * @returns the groups to render.
 */
export function groupBlocks(blocks: BlockInput[]): Group[] {
  const groups: Group[] = [];

  for (const block of blocks) {
    const last = groups[groups.length - 1];
    const parsed = parseBlock(block);

    switch (parsed.type) {
      case "heading":
        groups.push(parsed);
        break;
      case "listItem":
        if (last?.type === "list" && last.ordered === parsed.ordered) {
          last.items.push(parsed.item);
        } else {
          groups.push({
            type: "list",
            ordered: parsed.ordered,
            start: parsed.start,
            items: [parsed.item],
          });
        }
        break;
      case "tableHeader":
        groups.push({ type: "table", header: parsed.header, rows: [] });
        break;
      case "tableRow":
        if (last?.type === "table") {
          last.rows.push(parsed.cells);
        } else {
          groups.push({ type: "paragraph", item: parsed.asText });
        }
        break;
      default:
        groups.push(parsed);
    }
  }
  return groups;
}

function flatten(nodes: Inline[]): string {
  return nodes
    .map((n) =>
      n.type === "text" || n.type === "code" ? n.value : flatten(n.children)
    )
    .join("");
}
