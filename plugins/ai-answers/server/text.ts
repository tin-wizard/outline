const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "was",
  "were",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "when",
  "where",
  "why",
  "how",
  "does",
  "did",
  "can",
  "could",
  "should",
  "would",
  "will",
  "our",
  "your",
  "their",
  "its",
  "this",
  "that",
  "these",
  "those",
  "with",
  "from",
  "into",
  "about",
  "have",
  "has",
  "had",
  "any",
  "all",
  "not",
  "but",
  "you",
  "there",
  "here",
  "than",
  "then",
]);

const MAX_KEYWORDS = 8;

const CJK_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Extracts the significant words of a natural-language question.
 *
 * @param question the question as typed by the user.
 * @returns up to eight lowercase, deduplicated keywords, in order of first use.
 */
export function toKeywords(question: string): string[] {
  // shortcut: space-less CJK text becomes one long keyword; use real word
  // segmentation if CJK workspaces matter.
  const words = question
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
    .split(/\s+/)
    .filter(
      (word) =>
        ([...word].length > 2 || CJK_PATTERN.test(word)) &&
        !STOP_WORDS.has(word)
    );

  return [...new Set(words)].slice(0, MAX_KEYWORDS);
}

/**
 * Builds a full-text query that matches any keyword, so that a long question
 * still finds documents and ranking rewards those matching more of them.
 *
 * @param keywords the keywords from `toKeywords`.
 * @returns the query string, empty when there are no keywords.
 */
export function toKeywordQuery(keywords: string[]): string {
  return keywords.join(" or ");
}

/**
 * Splits markdown into sections that each begin at a heading.
 * Sections longer than `maxChars` are split further on blank lines.
 *
 * shortcut: a "# comment" line inside a fenced code block also starts a
 * section, which only makes that section smaller; fence-aware splitting if
 * code-heavy documents show up in evals.
 *
 * @param markdown the document text.
 * @param maxChars the preferred maximum length of a section.
 * @returns the non-empty sections in document order.
 */
export function splitIntoSections(markdown: string, maxChars = 1500): string[] {
  const sections: string[] = [];
  let current: string[] = [];

  const flush = () => {
    const text = current.join("\n").trim();
    if (text) {
      sections.push(text);
    }
    current = [];
  };

  for (const line of markdown.split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      flush();
    }
    current.push(line);
  }
  flush();

  return sections.flatMap((section) => splitOversized(section, maxChars));
}

function splitOversized(section: string, maxChars: number): string[] {
  if (section.length <= maxChars) {
    return [section];
  }

  const parts: string[] = [];
  let buffer = "";
  for (const paragraph of section.split(/\n{2,}/)) {
    if (buffer && buffer.length + paragraph.length + 2 > maxChars) {
      parts.push(buffer);
      buffer = "";
    }
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  if (buffer) {
    parts.push(buffer);
  }
  return parts;
}

/**
 * Picks the sections most relevant to the keywords that fit a character budget.
 * The opening section (usually the introduction) is always included first when
 * it fits. A section scores one point per keyword found in its text plus two
 * more per keyword found in its heading. When at least one other section
 * scores, only scoring sections are considered; when none do, sections are
 * taken in document order.
 *
 * @param sections the sections of one document, in document order.
 * @param keywords the keywords from `toKeywords`.
 * @param budgetChars the maximum total characters to return.
 * @returns the chosen sections, restored to document order.
 */
export function selectSections(
  sections: string[],
  keywords: string[],
  budgetChars: number
): string[] {
  const scored = sections.map((text, index) => {
    const lower = text.toLowerCase();
    const heading = (headingOf(text) ?? "").toLowerCase();
    const score =
      keywords.filter((keyword) => lower.includes(keyword)).length +
      2 * keywords.filter((keyword) => heading.includes(keyword)).length;
    return { text, index, score };
  });

  const chosen: typeof scored = [];
  let used = 0;
  const first = scored[0];
  const pinned = first && first.text.length <= budgetChars ? first : undefined;
  if (pinned) {
    chosen.push(pinned);
    used = pinned.text.length;
  }

  const rest = scored.filter((item) => item !== pinned);
  const matching = rest.filter((item) => item.score > 0);
  const candidates = matching.length > 0 ? matching : rest;
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);

  for (const item of candidates) {
    if (used + item.text.length > budgetChars) {
      continue;
    }
    chosen.push(item);
    used += item.text.length;
  }

  return chosen.sort((a, b) => a.index - b.index).map((item) => item.text);
}

/**
 * Returns the heading text of a section, if it starts with one.
 *
 * @param section a section from `splitIntoSections`.
 * @returns the heading without its leading hashes, or undefined.
 */
export function headingOf(section: string): string | undefined {
  const match = /^#{1,6}\s+(.+)$/m.exec(section.split("\n")[0] ?? "");
  return match?.[1]?.trim();
}
