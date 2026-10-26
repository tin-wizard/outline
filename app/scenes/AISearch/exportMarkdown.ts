import { isDocPath } from "./AnswerTurn";
import type { Turn } from "./model";
import { answerSegments, citedSources, sectionHeading } from "./model";

export interface TurnOptions {
  /** Prefix the answer with the quoted question. */
  includeQuestion: boolean;
  /** Append the numbered Sources list. */
  includeSources: boolean;
  /** Absolute origin for source links; defaults to the page origin. */
  origin?: string;
}

// Control characters and bidi overrides/isolates are dropped from plain text.
const INVISIBLE =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Escapes untrusted text (questions, titles) so it renders as literal text:
 * no links, emphasis, code, headings, lists or HTML.
 *
 * @param text the untrusted text, may contain newlines.
 * @returns the text with Markdown and HTML metacharacters backslash-escaped.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(INVISIBLE, "")
    .split(/\r\n|\r|\n/)
    .map((line) =>
      line
        .replace(/[\\`*_[\]()<>#&|!~{}]/g, "\\$&")
        .replace(
          /^(\s*)([-+=]|\d+[.)])/,
          (_m, space, marker: string) =>
            space + marker.replace(/([-+=.)])/, "\\$1")
        )
    )
    .join("\n");
}

/** Percent-encodes characters that could end a Markdown link destination. */
function encodeDestination(url: string): string {
  return url.replace(
    /[()<>`[\]"'\\]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
  );
}

function sourcesMarkdown(turn: Turn, origin: string): string {
  const lines: string[] = [];
  for (const source of citedSources(turn)) {
    const section = source.sections.find((x) => isDocPath(x.url));
    if (!section) {
      continue;
    }
    const title = escapeMarkdown(source.title).replace(/\s+/g, " ").trim();
    const heading = sectionHeading(section);
    lines.push(
      `${source.n}. [${title || "Untitled"}](${encodeDestination(origin + section.url)})${
        heading
          ? ` - ${escapeMarkdown(heading).replace(/\s+/g, " ").trim()}`
          : ""
      }`
    );
  }
  return lines.length ? `Sources\n\n${lines.join("\n")}` : "";
}

/** Plain line standing in for a block withheld because a source changed. */
export const HIDDEN_BLOCK_MARKDOWN =
  "_(A part of this answer is no longer available.)_";

/** Blocks of one list or table stay on consecutive lines. */
function joinBlocks(turn: Turn): string {
  const chunks = answerSegments(turn).map((segment) => {
    if (segment.type === "hidden") {
      return HIDDEN_BLOCK_MARKDOWN;
    }
    let out = "";
    let previous: string | undefined;
    for (const block of segment.blocks) {
      if (previous !== undefined) {
        const tight =
          (previous === "listItem" && block.kind === "listItem") ||
          ((previous === "tableHeader" || previous === "tableRow") &&
            block.kind === "tableRow");
        out += tight ? "\n" : "\n\n";
      }
      out += block.markdown;
      previous = block.kind;
    }
    return out;
  });
  return chunks.join("\n\n");
}

/**
 * Serializes one turn to Markdown. Answer blocks are the server-released,
 * already-escaped Markdown, copied verbatim; only the question and source
 * titles (untrusted) are escaped here.
 *
 * @param turn the turn.
 * @param options what to include.
 * @returns the Markdown, without a trailing newline.
 */
export function turnToMarkdown(turn: Turn, options: TurnOptions): string {
  const origin = options.origin ?? window.location.origin;
  const parts: string[] = [];
  if (options.includeQuestion) {
    parts.push(
      escapeMarkdown(turn.question)
        .split("\n")
        .map((line) => `> ${line}`.trimEnd())
        .join("\n")
    );
  }
  const body = joinBlocks(turn);
  if (body) {
    parts.push(body);
  }
  if (turn.problem || turn.status === "failed" || turn.status === "stopped") {
    parts.push("Not fully verified");
  }
  if (options.includeSources) {
    const sources = sourcesMarkdown(turn, origin);
    if (sources) {
      parts.push(sources);
    }
  }
  return parts.join("\n\n");
}

/**
 * Serializes a whole conversation to Markdown.
 *
 * @param turns the finished turns.
 * @param options.title the document title (escaped here).
 * @param options.origin absolute origin for source links.
 * @returns the Markdown with a trailing newline.
 */
export function conversationToMarkdown(
  turns: Turn[],
  options: { title: string; origin?: string }
): string {
  const title = escapeMarkdown(options.title).replace(/\s+/g, " ").trim();
  const body = turns
    .map((turn) =>
      turnToMarkdown(turn, {
        includeQuestion: true,
        includeSources: true,
        origin: options.origin,
      })
    )
    .join("\n\n---\n\n");
  return `# ${title}\n\n${body}\n`;
}

/**
 * Builds an ASCII-safe, date-stamped file name from the first question.
 *
 * @param question the first question.
 * @param date the date to stamp.
 * @returns a name such as `ai-search-how-do-we-onboard-2026-10-18.md`.
 */
export function exportFilename(question: string, date: Date): string {
  const slug = question
    .normalize("NFKD")
    .replace(/[^ -~]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return `ai-search-${slug ? `${slug}-` : ""}${date.toISOString().slice(0, 10)}.md`;
}
