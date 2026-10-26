import { groupBlocks } from "./markdown";
import type { Inline } from "./markdown";
import type { Turn } from "./model";

/** Comparisons have at most three documents: A, B and C. */
export const MAX_COMPARE_COLUMNS = 3;

function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) =>
      node.type === "text" || node.type === "code"
        ? node.value
        : inlineText(node.children)
    )
    .join("");
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Whether a turn was asked in compare mode.
 *
 * @param turn the turn.
 * @returns true for compare turns.
 */
export function isCompare(turn: Turn): boolean {
  return turn.scope.mode === "compare";
}

/**
 * Maps source numbers to the letters of a comparison. Columns are lettered in
 * header order (the first document column is A); a source takes the letter of
 * the column whose header is its title. Sources the header doesn't name keep
 * their retrieval order after the lettered ones.
 *
 * @param turn a compare turn.
 * @returns letter by source number, at most three; empty without sources.
 */
export function compareLetters(turn: Turn): Map<number, string> {
  const letters = new Map<number, string>();
  const sources = turn.sources ?? [];
  const table = groupBlocks(turn.blocks).find((g) => g.type === "table");
  const columns =
    table?.type === "table"
      ? table.header.slice(1).map((cell) => normalize(inlineText(cell.inline)))
      : [];
  const taken = new Set<number>();
  for (const source of sources) {
    const column = columns.indexOf(normalize(source.title));
    if (column >= 0 && column < MAX_COMPARE_COLUMNS && !taken.has(column)) {
      taken.add(column);
      letters.set(source.n, String.fromCharCode(65 + column));
    }
  }
  let next = 0;
  for (const source of sources) {
    if (letters.has(source.n)) {
      continue;
    }
    while (taken.has(next)) {
      next++;
    }
    if (next < MAX_COMPARE_COLUMNS) {
      taken.add(next);
      letters.set(source.n, String.fromCharCode(65 + next));
    }
  }
  return letters;
}

/** Colours for the A, B and C tags, as theme keys. */
export const TAG_COLORS = ["textTertiary", "accent", "warning"] as const;

/**
 * The theme colour key of a letter tag.
 *
 * @param letter "A", "B" or "C".
 * @returns the key.
 */
export function tagColor(letter: string): (typeof TAG_COLORS)[number] {
  return TAG_COLORS[Math.max(0, letter.charCodeAt(0) - 65)] ?? "textTertiary";
}
