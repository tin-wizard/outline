import type { Block } from "./blocks";
import {
  NO_ANSWER,
  type FinishReason,
  type ProviderCitation,
  type ProviderResult,
} from "./contract";
import { redactSecrets } from "./redact";
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
  /** True when the model abstained (replied with the NO_ANSWER sentinel). */
  abstained: boolean;
}

const MAX_QUOTE = 300;

/** Shortest uncited text that can be trusted as a verbatim copy of a source. */
const MIN_GROUNDED_LENGTH = 25;

function truncate(text: string): string {
  return text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text;
}

/**
 * NFKC-normalises text and rewrites every Unicode decimal digit (fullwidth,
 * Arabic-Indic, ...) as an ASCII digit so numbers compare by value.
 */
function foldDigits(text: string): string {
  return text.normalize("NFKC").replace(/\p{Nd}/gu, (char) => {
    // Digit blocks are contiguous runs of ten starting at zero.
    let offset = 0;
    let code = char.codePointAt(0) ?? 0;
    while (/\p{Nd}/u.test(String.fromCodePoint(code - 1))) {
      code--;
      offset++;
    }
    return String(offset % 10);
  });
}

/**
 * Lowercases and strips markdown markers and extra whitespace for comparison.
 *
 * @param text the text to normalise.
 * @returns the normalised text.
 */
export function normalise(text: string): string {
  return foldDigits(text)
    .toLowerCase()
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Share of a segment's content words that must appear in the cited passage.
 * Deliberately low so honest paraphrases pass; invented sentences carry mostly
 * new words and fall well below it. Exact tokens (numbers, URLs, emails, code
 * tokens, acronyms) are checked separately and strictly.
 *
 * Known limits, covered only by this ratio: unit or currency swaps ("days" for
 * "weeks"), negation flips, invented capitalised names and lowercase acronyms.
 */
const MIN_CONTENT_WORD_SUPPORT = 0.5;

/** Longest cited range, in sections; wider ranges make the passage too loose. */
const MAX_CITED_SECTIONS = 3;

/** Shortest normalised quote accepted; shorter ones match almost anywhere. */
const MIN_QUOTE_LENGTH = 8;

const NUMBER_WORDS: Record<string, number> = Object.fromEntries(
  "zero two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen"
    .split(" ")
    .map((word, i) => [word, i === 0 ? 0 : i + 1])
);
const TENS_WORDS: Record<string, number> = Object.fromEntries(
  "twenty thirty forty fifty sixty seventy eighty ninety"
    .split(" ")
    .map((word, i) => [word, (i + 2) * 10])
);
// A bare "one" is mostly a pronoun, so it is only read as a number in compounds.
const NUMBER_WORD_PATTERN = new RegExp(
  `\\b(?:(${Object.keys(TENS_WORDS).join("|")})(?:[\\s-]+(one|two|three|four|five|six|seven|eight|nine))?|one hundred|hundred|${Object.keys(NUMBER_WORDS).join("|")})\\b`,
  "g"
);

/** Rewrites number words from zero to one hundred as digits, in lowercase text. */
function foldNumberWords(text: string): string {
  return text.replace(
    NUMBER_WORD_PATTERN,
    (match, tens?: string, unit?: string) => {
      if (tens) {
        return String(
          TENS_WORDS[tens] +
            (unit ? (unit === "one" ? 1 : NUMBER_WORDS[unit]) : 0)
        );
      }
      return match.endsWith("hundred") ? "100" : String(NUMBER_WORDS[match]);
    }
  );
}

/** Conservative suffix stripping so "holidays" and "received" meet "holiday" and "receive". */
function stem(word: string): string {
  if (word.length < 4) {
    return word;
  }
  let out = word;
  for (const suffix of ["ing", "ed", "ly", "s"]) {
    if (
      out.endsWith(suffix) &&
      out.length - suffix.length >= 3 &&
      !(suffix === "s" && out.endsWith("ss"))
    ) {
      out = out.slice(0, -suffix.length);
      break;
    }
  }
  return out.length > 3 && out.endsWith("e") ? out.slice(0, -1) : out;
}

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
const NUMBER_PATTERN = /\p{Nd}+(?:[.,]\p{Nd}+)*/gu;
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
 * Checks that every number, URL, email, code span and acronym/ID in the text
 * occurs in the passage.
 *
 * @param text the generated text.
 * @param passage the source text, already normalised with number words folded.
 * @returns the text with URLs, emails and code spans removed, or undefined when a token is missing.
 */
function proseIfExactTokensIn(
  text: string,
  passage: string
): string | undefined {
  text = foldDigits(text);
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
  const numbers = [
    ...foldNumberWords(prose.toLowerCase()).matchAll(NUMBER_PATTERN),
  ].map((m) => m[0]);
  const urlLike = exact.map((t) => t.replace(/[.,;:!?]+$/, ""));
  if (
    urlLike.some((t) => !containsToken(haystack, normalise(t))) ||
    numbers.some((t) => !containsToken(haystack, ungroup(t), /[\d.]/))
  ) {
    return undefined;
  }
  return prose;
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
  passage = foldNumberWords(normalise(passage));
  const prose = proseIfExactTokensIn(text, passage);
  if (prose === undefined) {
    return false;
  }

  const split = (value: string) =>
    foldNumberWords(normalise(value)).split(/[^\p{L}\p{N}]+/u);
  const passageWords = new Set(split(passage).map(stem));
  const words = [
    ...new Set(
      split(prose)
        .filter((w) => w && !STOPWORDS.has(w))
        .map(stem)
    ),
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
    return {
      answer: null,
      citations: [],
      droppedSegments: 0,
      abstained: false,
    };
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
    const valid = segment.citations.flatMap((c) => {
      const resolved = resolveCitation(c, sources);
      return resolved ? [resolved] : [];
    });
    const backed = valid.length > 0;
    const cited = valid.map((v) => v.passage).join(" ");
    // Every sentence must stand alone: an invented one must not ride along with a real one.
    if (
      backed &&
      !sentencesOf(text).every((sentence) => isTextSupported(sentence, cited))
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
    return { answer: null, citations: [], droppedSegments, abstained };
  }
  return {
    answer,
    citations: [...citations.values()],
    droppedSegments,
    abstained,
  };
}

/** Why `verifyBlock` did not release a block. */
export type BlockDropReason =
  | "empty"
  | "sentinel"
  | "html"
  | "image"
  | "link"
  | "url"
  | "email"
  | "code"
  | "structure"
  | "unsupported"
  | "uncited";

/** A block that may be released, with its sanitised content. */
export interface AcceptedBlock {
  ok: true;
  /** The sanitised block: secrets redacted, model-written links reduced to their text. */
  block: Block;
  /** Sources backing the block; empty for structural blocks. */
  citations: AnswerCitation[];
  /** True when a valid provider citation backs the block (counts for `verifyFinal`). */
  modelCited: boolean;
}

/** A block that must not be released. */
export interface DroppedBlock {
  ok: false;
  reason: BlockDropReason;
  /** The block with secrets redacted; never show it to the user. */
  block: Block;
}

/** The outcome of verifying one block. */
export type BlockVerdict = AcceptedBlock | DroppedBlock;

/** What `verifyFinal` needs to know about a finished answer. */
export interface FinalState {
  finishReason: FinishReason;
  /** Everything the model generated, released or not. */
  text: string;
  /** The blocks that `verifyBlock` accepted. */
  released: Pick<AcceptedBlock, "modelCited">[];
}

/** Why a finished answer failed the final gate. */
export type FinalFailure = "unfinished" | "abstained" | "empty" | "uncited";

/** The outcome of the final gate. */
export type FinalVerdict = { ok: true } | { ok: false; reason: FinalFailure };

/**
 * Decides whether one Markdown block may be released. Every block is
 * redacted, loses model-written link syntax (only the visible text is kept)
 * and is dropped for HTML, images, the abstention sentinel or URLs/emails not
 * in the sent sections. Then, by kind:
 *
 * - paragraph, list item, table body row: every sentence (every cell for a
 *   row) must be supported by the passages of valid provider citations, as in
 *   `verifyAnswer`; without a valid citation the block must be a verbatim copy
 *   (at least 25 characters) of a sent section. Paragraphs and list items may
 *   also be a short lead-in ending with a colon, or plain statements of what
 *   the documents do not cover.
 * - heading, table header row: at most 80 characters, no URL or email, every
 *   number, identifier and code-like token present in the sent sections, and
 *   most words from the sent sections or a small structural vocabulary.
 * - code block: a verbatim substring of a sent section, ignoring trailing
 *   whitespace on each line.
 *
 * @param block the block, as produced by `BlockSplitter`.
 * @param citations the provider citations attached to the block, normally `block.citations`.
 * @param sources the sources that were sent, in order.
 * @returns the sanitised block and its citations, or the reason it was dropped.
 */
export function verifyBlock(
  block: Block,
  citations: ProviderCitation[],
  sources: AnswerSource[]
): BlockVerdict {
  if (block.kind === "code") {
    return verifyCode(block, sources);
  }

  const redact = (value: string) => redactSecrets(value).text;
  const redacted: Block = {
    ...block,
    text: redact(block.text),
    cells: block.cells.map(redact),
  };
  const drop = (reason: BlockDropReason): DroppedBlock => ({
    ok: false,
    reason,
    block: redacted,
  });

  const parts = block.kind.startsWith("table")
    ? redacted.cells
    : [redacted.text];
  const cleaned: string[] = [];
  for (const part of parts) {
    const result = stripMarkup(part);
    if (typeof result !== "string") {
      return drop(result.reason);
    }
    cleaned.push(result);
  }
  const text = block.kind.startsWith("table")
    ? cleaned.join(" | ")
    : cleaned[0];
  const clean: Block = {
    ...redacted,
    text,
    cells: block.kind.startsWith("table") ? cleaned : [],
    inlineCode: [...text.matchAll(CODE_SPAN_PATTERN)].map((m) => m[1]),
  };

  if (!/[\p{L}\p{N}]/u.test(text)) {
    return drop("empty");
  }
  if (text.includes(NO_ANSWER)) {
    return drop("sentinel");
  }
  const sent = sources.flatMap((s) => s.sections).join("\n");
  const known = normalise(sent);
  const structural = block.kind === "heading" || block.kind === "tableHeader";
  const isNovel = (token: string) =>
    structural ||
    !containsToken(known, normalise(token.replace(/[.,;:!?]+$/, "")));
  if ((text.match(ANY_URL_PATTERN) ?? []).some(isNovel)) {
    return drop("url");
  }
  if ((text.match(EMAIL_PATTERN) ?? []).some(isNovel)) {
    return drop("email");
  }
  const accept = (
    backing: AnswerCitation[],
    modelCited: boolean
  ): AcceptedBlock => ({
    ok: true,
    block: clean,
    citations: [...new Map(backing.map((c) => [citationKey(c), c])).values()],
    modelCited,
  });

  if (structural) {
    return isStructural(text, sent, known)
      ? accept([], false)
      : drop("structure");
  }

  const valid = citations.flatMap((c) => {
    const resolved = resolveCitation(c, sources);
    return resolved ? [resolved] : [];
  });
  const prose = block.kind !== "tableRow";
  if (valid.length > 0) {
    const passage = valid.map((v) => v.passage).join(" ");
    const units = prose ? sentencesOf(text) : cleaned.filter((c) => c.trim());
    const supported = units.every(
      (unit) =>
        isTextSupported(unit, passage) ||
        (prose && isGapStatement(unit, sent, known))
    );
    return supported
      ? accept(
          valid.map((v) => v.entry),
          true
        )
      : drop("unsupported");
  }

  const copied = findVerbatim(text, sources);
  if (copied) {
    return accept([copied], false);
  }
  if (
    prose &&
    (isLeadIn(text, sent, known) ||
      sentencesOf(text).every((s) => isGapStatement(s, sent, known)))
  ) {
    return accept([], false);
  }
  return drop("uncited");
}

/**
 * The gate that needs the whole answer: the model finished cleanly, never
 * abstained, at least one block was released, and at least one released block
 * is backed by a real model citation.
 *
 * @param state the finish reason, all generated text and the released blocks.
 * @returns ok, or the reason the answer failed.
 */
export function verifyFinal(state: FinalState): FinalVerdict {
  if (state.finishReason !== "stop") {
    return { ok: false, reason: "unfinished" };
  }
  if (state.text.includes(NO_ANSWER)) {
    return { ok: false, reason: "abstained" };
  }
  if (state.released.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (!state.released.some((b) => b.modelCited)) {
    return { ok: false, reason: "uncited" };
  }
  return { ok: true };
}

/** Longest uncited heading, table header or lead-in. */
const MAX_STRUCTURAL_LENGTH = 80;

/** Longest statement of what the documents do not cover. */
const MAX_GAP_LENGTH = 160;

/**
 * Words a heading or lead-in may use without them being in the sources;
 * they label structure and assert nothing.
 */
const STRUCTURAL_WORDS = (
  "overview summary details detail background introduction integrations integration steps step " +
  "setup set up install installation configuration configure usage use using example examples " +
  "notes note comparison compare differences difference troubleshooting diagnosis causes cause " +
  "fixes fix solution solutions requirements prerequisites options option features feature key " +
  "points related information further following below these here how what why documents document " +
  "sources source cover covered mention answer follow run next first then finally limitations known issues"
).replace(/\s+/g, " ");

/** Scheme URLs, www. hosts and scheme-less host/path addresses. */
const ANY_URL_PATTERN =
  /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/)[^\s<>()[\]"'`]*/gi;

/** Tokens that look like code: paths, flags, calls, member access, assignments. */
const CODE_LIKE_PATTERN = /[/\\{}$<>=~]|\w\.\w|--|::|\(\)/;

const GAP_PATTERN =
  /^(?:the\s+)?(?:provided\s+|available\s+)?(?:documents?|sources?|search results|knowledge base)\s+(?:provided\s+)?(?:do|does)\s*(?:not|n['’]t)\s+(?:cover|mention|say|state|describe|specify|include|contain|explain|address|discuss|list|provide|detail)\b[^,;:()]*$/i;

/** Words that would let a gap statement carry a claim of its own. */
const GAP_BLOCKERS =
  /\b(?:but|however|although|though|instead|yet|because|since|while|whereas|therefore|so|that|which|and\s+(?:is|are|was|were|it|they))\b/i;

/** Accepts a citation only when it maps to sent sections and its quote is in them. */
function resolveCitation(
  citation: ProviderCitation,
  sources: AnswerSource[]
): { key: string; entry: AnswerCitation; passage: string } | undefined {
  const source = sources[citation.sourceIndex];
  const section = source?.sections[citation.sectionIndex];
  if (
    !source ||
    section === undefined ||
    !Number.isInteger(citation.sectionIndex) ||
    !Number.isInteger(citation.endSectionIndex) ||
    citation.endSectionIndex <= citation.sectionIndex ||
    citation.endSectionIndex - citation.sectionIndex > MAX_CITED_SECTIONS ||
    citation.endSectionIndex > source.sections.length
  ) {
    return undefined;
  }
  const passage = normalise(
    source.sections
      .slice(citation.sectionIndex, citation.endSectionIndex)
      .join("\n")
  );
  const quote = normalise(citation.quote);
  // The provider's quote must really be in the sent sections it points at.
  if (quote.length < MIN_QUOTE_LENGTH || !passage.includes(quote)) {
    return undefined;
  }
  const entry = citationFor(source, section, citation.quote);
  return { key: citationKey(entry), passage, entry };
}

function citationFor(
  source: AnswerSource,
  section: string,
  quote: string
): AnswerCitation {
  return {
    documentId: source.document.id,
    title: source.document.title,
    url: source.document.url,
    heading: headingOf(section),
    quote: truncate(quote),
  };
}

function citationKey(citation: AnswerCitation): string {
  return `${citation.documentId}:${citation.heading ?? ""}`;
}

/** Splits text into sentences and lines; an invented one must not ride along with a real one. */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => sentence.trim());
}

/** Reduces model-written links to their text; rejects images, link definitions and HTML. */
function stripMarkup(text: string): string | { reason: BlockDropReason } {
  if (/!\[[^\]]*\]\s*[([]/.test(text)) {
    return { reason: "image" };
  }
  if (/^\s*\[[^\]]+\]:/m.test(text)) {
    return { reason: "link" };
  }
  // Bounded: each pass removes at least one pair of brackets.
  for (let previous = ""; previous !== text;) {
    previous = text;
    text = text
      .replace(/\[([^[\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
      .replace(/\[([^[\]]*)\]\[[^\]]*\]/g, "$1");
  }
  if (/<[A-Za-z/!?]/.test(text)) {
    return { reason: "html" };
  }
  return text;
}

/** An uncited block counts as a source copy when it is long and verbatim. */
function findVerbatim(
  text: string,
  sources: AnswerSource[]
): AnswerCitation | undefined {
  // Table rows are compared with uniform spacing around the pipes.
  const flat = (value: string) => normalise(value).replace(/\s*\|\s*/g, " | ");
  const needle = flat(text);
  if (needle.length < MIN_GROUNDED_LENGTH) {
    return undefined;
  }
  for (const source of sources) {
    const section = source.sections.find((s) => flat(s).includes(needle));
    if (section !== undefined) {
      return citationFor(source, section, text);
    }
  }
  return undefined;
}

/** Whether every code-like token in the text appears in the sent sections. */
function codeLikeTokensKnown(text: string, known: string): boolean {
  return text
    .split(/\s+/)
    .map((token) => token.replace(/^[("'`*]+|[)"'`*.,;:!?]+$/g, ""))
    .filter((token) => CODE_LIKE_PATTERN.test(token))
    .every((token) => containsToken(known, normalise(token)));
}

/** A short label that carries no claim the sources do not make. */
function isStructural(text: string, sent: string, known: string): boolean {
  return (
    text.length <= MAX_STRUCTURAL_LENGTH &&
    !text.match(ANY_URL_PATTERN) &&
    !text.match(EMAIL_PATTERN) &&
    codeLikeTokensKnown(text, known) &&
    isTextSupported(text, `${sent}\n${STRUCTURAL_WORDS}`)
  );
}

/** A one-line structural lead-in to a list, table or code block. */
function isLeadIn(text: string, sent: string, known: string): boolean {
  return (
    text.endsWith(":") &&
    sentencesOf(text).length === 1 &&
    isStructural(text, sent, known)
  );
}

/** A plain statement of what the sources do not cover, with no claim of its own. */
function isGapStatement(
  sentence: string,
  sent: string,
  known: string
): boolean {
  const text = sentence.trim();
  return (
    text.length <= MAX_GAP_LENGTH &&
    GAP_PATTERN.test(text) &&
    !GAP_BLOCKERS.test(text) &&
    !text.match(ANY_URL_PATTERN) &&
    !text.match(EMAIL_PATTERN) &&
    codeLikeTokensKnown(text, known) &&
    proseIfExactTokensIn(text, foldNumberWords(normalise(sent))) !== undefined
  );
}

/** A code block must be copied verbatim from a sent section. */
function verifyCode(block: Block, sources: AnswerSource[]): BlockVerdict {
  const trimLines = (value: string) =>
    value
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n");
  const text = trimLines(redactSecrets(block.text).text).replace(
    /^\n+|\n+$/g,
    ""
  );
  const clean: Block = {
    ...block,
    text,
    marker: /^[\w+#.-]{1,20}$/.test(block.marker) ? block.marker : "",
  };
  if (!text.trim()) {
    return { ok: false, reason: "empty", block: clean };
  }
  if (text.includes(NO_ANSWER)) {
    return { ok: false, reason: "sentinel", block: clean };
  }
  for (const source of sources) {
    const section = source.sections.find((s) =>
      containsToken(trimLines(s), text)
    );
    if (section !== undefined) {
      return {
        ok: true,
        block: clean,
        citations: [citationFor(source, section, text)],
        modelCited: false,
      };
    }
  }
  return { ok: false, reason: "code", block: clean };
}
