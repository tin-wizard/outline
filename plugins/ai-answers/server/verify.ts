import { NO_ANSWER, type ProviderResult } from "./contract";
import type { AnswerSource } from "./retrieve";
import { headingOf } from "./text";

/** A passage of a document that supports the answer. */
export interface AnswerCitation {
  documentId: string;
  title: string;
  url: string;
  heading?: string;
  quote: string;
}

/** The outcome of asking a question. `answer` is null when nothing was found. */
export interface AnswerResult {
  answer: string | null;
  citations: AnswerCitation[];
}

/** An answer result plus how many segments the verifier discarded. */
export interface VerifiedAnswer extends AnswerResult {
  droppedSegments: number;
}

const MAX_QUOTE = 300;

/** Shortest uncited text that can be trusted as a verbatim copy of a source. */
const MIN_GROUNDED_LENGTH = 25;

function truncate(text: string): string {
  return text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text;
}

/**
 * Lowercases and strips markdown markers and extra whitespace for comparison.
 *
 * @param text the text to normalise.
 * @returns the normalised text.
 */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Share of a segment's content words that must appear in the cited passage.
 * Deliberately low so honest paraphrases pass; invented sentences carry mostly
 * new words and fall well below it. Exact tokens (see `findUnsupportedTokens`)
 * are checked separately and strictly.
 */
const MIN_CONTENT_WORD_SUPPORT = 0.5;

/** Words that carry no claim; ignored when measuring paraphrase overlap. */
const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its " +
    "may might more most no not of on or our she should so than that the their them then there these they this those to " +
    "was we were what when where which who will with would you your also such per via"
  ).split(" ")
);

const URL_PATTERN = /https?:\/\/[^\s)>\]"']+/gi;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const CODE_SPAN_PATTERN = /`([^`]+)`/g;
const NUMBER_PATTERN = /\d+(?:[.,]\d+)*/g;
const IDENTIFIER_PATTERNS = [
  /\b[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)*\b/g, // acronyms and IDs: API, PROJ-123
  /\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\b/g, // snake_case
  /\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g, // camelCase
];

/** Drops digit-group commas so "1,000" and "1000" compare equal. */
function ungroup(text: string): string {
  return text.replace(/(?<=\d),(?=\d)/g, "");
}

/**
 * Whether `needle` occurs in `haystack` without being part of a longer token.
 * Numbers only compare against digits, so "28" matches "28th" but not "128".
 */
function containsToken(
  haystack: string,
  needle: string,
  edge = /[\p{L}\p{N}]/u
): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) {
      return false;
    }
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    if (!(before && edge.test(before)) && !(after && edge.test(after))) {
      return true;
    }
    from = at + 1;
  }
}

/**
 * Whether the text is supported by the passage: every number, URL, email,
 * code-like token and acronym/ID in it appears in the passage, and at least
 * `MIN_CONTENT_WORD_SUPPORT` of its content words do too.
 *
 * @param text the generated text to check.
 * @param passage the source text it must be supported by.
 * @returns true when the text is supported.
 */
export function isTextSupported(text: string, passage: string): boolean {
  passage = normalise(passage);
  const exact: string[] = [];
  const collect = (pattern: RegExp, group = 0) => {
    for (const m of text.matchAll(pattern)) {
      exact.push(m[group]);
    }
  };
  collect(URL_PATTERN);
  collect(EMAIL_PATTERN);
  collect(CODE_SPAN_PATTERN, 1);
  const prose = text
    .replace(URL_PATTERN, " ")
    .replace(EMAIL_PATTERN, " ")
    .replace(CODE_SPAN_PATTERN, " ");
  for (const pattern of IDENTIFIER_PATTERNS) {
    for (const m of prose.matchAll(pattern)) {
      exact.push(m[0]);
    }
  }
  const haystack = ungroup(passage);
  const numbers = [...prose.matchAll(NUMBER_PATTERN)].map((m) => m[0]);
  const urlLike = exact.map((t) => t.replace(/[.,;:!?]+$/, ""));
  if (
    urlLike.some((t) => !containsToken(haystack, normalise(t))) ||
    numbers.some((t) => !containsToken(haystack, ungroup(t), /[\d.]/))
  ) {
    return false;
  }

  const split = (value: string) => normalise(value).split(/[^\p{L}\p{N}]+/u);
  const passageWords = new Set(split(passage));
  const words = [
    ...new Set(split(prose).filter((w) => w && !STOPWORDS.has(w))),
  ];
  if (words.length === 0) {
    return true;
  }
  const found = words.filter((w) => passageWords.has(w)).length;
  return found / words.length >= MIN_CONTENT_WORD_SUPPORT;
}

/**
 * Applies the trust rules to a provider result. A citation counts only when it
 * maps to real sections that were sent and its quote occurs in them. A cited
 * segment is kept only when its numbers, URLs, emails, code tokens and
 * acronyms all appear in the cited passage and most of its content words do
 * too; otherwise it is dropped. Uncited text is kept only when copied
 * verbatim (at least 25 characters) from a sent section. The answer is returned only with at least one real
 * model citation, and only when the provider finished cleanly.
 *
 * @param result the unverified provider result.
 * @param sources the sources that were sent, in order.
 * @returns the verified answer and citations, or `answer: null`.
 */
export function verifyAnswer(
  result: ProviderResult,
  sources: AnswerSource[]
): VerifiedAnswer {
  // Anything but a clean finish (refusal, max_tokens, pause_turn, tool_use) may be partial.
  if (result.finishReason !== "stop") {
    return { answer: null, citations: [], droppedSegments: 0 };
  }

  const normalisedSections = sources.flatMap((source) =>
    source.sections.map((section) => ({
      source,
      section,
      text: normalise(section),
    }))
  );
  const parts: string[] = [];
  const citations = new Map<string, AnswerCitation>();
  let hasModelCitation = false;
  let droppedSegments = 0;
  for (const segment of result.segments) {
    const text = segment.text.trim();
    const valid: { key: string; entry: AnswerCitation; passage: string }[] = [];
    for (const citation of segment.citations) {
      const source = sources[citation.sourceIndex];
      const section = source?.sections[citation.sectionIndex];
      if (
        !source ||
        section === undefined ||
        citation.endSectionIndex <= citation.sectionIndex ||
        citation.endSectionIndex > source.sections.length
      ) {
        continue;
      }
      const passage = normalise(
        source.sections
          .slice(citation.sectionIndex, citation.endSectionIndex)
          .join("\n")
      );
      const quote = normalise(citation.quote);
      // The provider's quote must really be in the sent sections it points at.
      if (!quote || !passage.includes(quote)) {
        continue;
      }
      const heading = headingOf(section);
      valid.push({
        key: `${source.document.id}:${heading ?? ""}`,
        passage,
        entry: {
          documentId: source.document.id,
          title: source.document.title,
          url: source.document.url,
          heading,
          quote: truncate(citation.quote),
        },
      });
    }
    const backed = valid.length > 0;
    if (
      backed &&
      !isTextSupported(text, valid.map((v) => v.passage).join(" "))
    ) {
      droppedSegments++;
      continue;
    }
    for (const v of valid) {
      citations.set(v.key, v.entry);
      hasModelCitation = true;
    }
    if (backed) {
      parts.push(text);
      continue;
    }

    const needle = normalise(text);
    if (needle.length < MIN_GROUNDED_LENGTH) {
      droppedSegments++;
      continue;
    }
    const match = normalisedSections.find((s) => s.text.includes(needle));
    if (!match) {
      droppedSegments++;
      continue;
    }
    const heading = headingOf(match.section);
    const key = `${match.source.document.id}:${heading ?? ""}`;
    if (!citations.has(key)) {
      citations.set(key, {
        documentId: match.source.document.id,
        title: match.source.document.title,
        url: match.source.document.url,
        heading,
        quote: truncate(text),
      });
    }
    parts.push(text);
  }

  const answer = parts.join(" ").trim();
  // NO_ANSWER anywhere, even in dropped text, means the model abstained.
  const abstained = result.segments.some((s) => s.text.includes(NO_ANSWER));
  if (!answer || abstained || !hasModelCitation) {
    return { answer: null, citations: [], droppedSegments };
  }
  return { answer, citations: [...citations.values()], droppedSegments };
}
