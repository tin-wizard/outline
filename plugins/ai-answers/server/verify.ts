import type { Block } from "./blocks";
import {
  MAX_COMPARE_SOURCES,
  type AnswerMode,
  type FinishReason,
  type ProviderCitation,
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
  /** The editor's heading id for the first cited section, when known. */
  anchor?: string;
  /** Plain visible text of that heading, when known and safe to show. */
  headingText?: string;
  quote: string;
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
// Bounded so a long run of word characters cannot make matching quadratic.
const EMAIL_PATTERN = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,10}/g;
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
  return (
    (supportRatio(text, toPassage(passage)) ?? 0) >= MIN_CONTENT_WORD_SUPPORT
  );
}

/** Source text prepared once for repeated support checks. */
export interface Passage {
  /** Normalised text. */
  text: string;
  /** Normalised text with number words folded to digits. */
  folded: string;
  /** Stemmed words of the text. */
  words: Set<string>;
}

function splitWords(value: string): string[] {
  return foldNumberWords(normalise(value)).split(/[^\p{L}\p{N}]+/u);
}

function toPassage(raw: string): Passage {
  const text = normalise(raw);
  const folded = foldNumberWords(text);
  return { text, folded, words: new Set(splitWords(folded).map(stem)) };
}

/**
 * Share of the text's content words found in the passage, or undefined when
 * a number, URL, email, code span or acronym/ID in it is missing there.
 */
function supportRatio(
  text: string,
  passage: Passage,
  countRepeats = false
): number | undefined {
  const prose = proseIfExactTokensIn(text, passage.folded);
  if (prose === undefined) {
    return undefined;
  }
  const all = splitWords(prose)
    .filter((w) => w && !STOPWORDS.has(w))
    .map(stem);
  const words = [...new Set(all)];
  if (words.length === 0) {
    return 1;
  }
  const unique =
    words.filter((w) => passage.words.has(w)).length / words.length;
  if (!countRepeats) {
    return unique;
  }
  // Counted with repeats too, so padding with one junk word cannot hide behind a single miss.
  const counted = all.filter((w) => passage.words.has(w)).length / all.length;
  return Math.min(unique, counted);
}

/** Why `verifyBlock` did not release a block. */
export type BlockDropReason =
  | "long"
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
  | "uncited"
  | "table"
  | "comparative";

/** A block that may be released, with its sanitised content. */
export interface AcceptedBlock {
  ok: true;
  /** The sanitised block: secrets redacted, model-written links reduced to their text. */
  block: Block;
  /** Sources backing the block; empty for structural blocks and gap statements. */
  citations: AnswerCitation[];
  /**
   * True only when a sentence (or table row) passed the support check against
   * a valid provider citation; this is what `verifyFinal` counts.
   */
  modelCited: boolean;
}

/** A block that must not be released. */
export interface DroppedBlock {
  ok: false;
  reason: BlockDropReason;
  /** The block with secrets redacted (emptied when over the length cap); never show it. */
  block: Block;
}

/** The outcome of verifying one block. */
export type BlockVerdict = AcceptedBlock | DroppedBlock;

/** What `verifyFinal` needs to know about a finished answer. */
export interface FinalState {
  finishReason: FinishReason;
  /** Everything the model generated, released or not. */
  text: string;
  /** The verdicts of the released blocks. */
  released: AcceptedBlock[];
}

/** Why a finished answer failed the final gate. */
export type FinalFailure = "unfinished" | "abstained" | "empty" | "uncited";

/** The outcome of the final gate. */
export type FinalVerdict = { ok: true } | { ok: false; reason: FinalFailure };

/** The sent sources, normalised once so each block can be checked cheaply. */
export interface PreparedSources {
  sources: AnswerSource[];
  /** Every sent section, normalised. */
  known: Passage;
  /** Every sent section plus the structural vocabulary, for labels. */
  labels: Passage;
  /** Per source and section: normalised text with uniform pipes and its line bounds, for verbatim copies. */
  flat: FlatSection[][];
  /** Per source and section: raw text with trailing whitespace trimmed per line, for code. */
  code: string[][];
}

/**
 * Normalises the sent sources once for `verifyBlock`.
 *
 * @param sources the sources that were sent, in order.
 * @returns the prepared sources.
 */
export function prepareSources(sources: AnswerSource[]): PreparedSources {
  const sent = sources.flatMap((s) => s.sections).join("\n");
  return {
    sources,
    known: toPassage(sent),
    labels: toPassage(`${sent}\n${STRUCTURAL_WORDS}`),
    flat: sources.map((s) => s.sections.map(flattenLines)),
    code: sources.map((s) => s.sections.map(trimLines)),
  };
}

/**
 * The sources a comparison puts side by side: the first `MAX_COMPARE_SOURCES`
 * whose redacted titles differ, so every table column maps to one document.
 *
 * @param sources the retrieved sources, best first.
 * @returns at most three sources with distinct titles, in order.
 */
export function compareSources(sources: AnswerSource[]): AnswerSource[] {
  const seen = new Set<string>();
  return sources
    .filter((source) => {
      const title = compareTitle(source);
      if (seen.has(title)) {
        return false;
      }
      seen.add(title);
      return true;
    })
    .slice(0, MAX_COMPARE_SOURCES);
}

/**
 * Decides whether one Markdown block may be released. Every block must be at
 * most 4000 characters and is dropped for the abstention sentinel. Non-code
 * blocks are redacted, lose model-written link syntax (only the visible text is
 * kept) and are dropped for images, leftover link/reference syntax, HTML, or
 * URLs, bare domains or emails not in the sent sections. Then, by kind:
 *
 * - paragraph, list item: every sentence must be supported by the passage of
 *   one valid provider citation (content words, exact tokens and code-like
 *   tokens), or be a plain statement of what the documents do not cover.
 *   Without a valid citation the block must be a verbatim copy (at least 25
 *   characters) of a sent section, a short lead-in ending with a colon whose
 *   words all come from the sources, or only gap statements.
 * - table body row: every cell and the whole row must be supported by one
 *   cited passage, including yes/no words; or a verbatim copy.
 * - heading, table header row: at most 80 characters, no URL or email, all
 *   numbers, identifiers and code-like tokens in the sent sections, and at
 *   least 80% of words from the sent sections or a structural vocabulary.
 * - code block: at least 8 characters and a verbatim substring of a sent
 *   section, ignoring trailing whitespace on each line.
 *
 * @param block the block, as produced by `BlockSplitter`.
 * @param citations the provider citations attached to the block, normally `block.citations`.
 * @param sources the sources that were sent, in order, raw or from `prepareSources`.
 * @returns the sanitised block and its citations, or the reason it was dropped.
 */
export function verifyBlock(
  block: Block,
  citations: ProviderCitation[],
  sources: AnswerSource[] | PreparedSources
): BlockVerdict {
  const ctx = Array.isArray(sources) ? prepareSources(sources) : sources;
  if (isTooLong(block)) {
    return dropEmptied(block, "long");
  }
  if (block.kind === "code") {
    return verifyCode(block, ctx);
  }
  const sanitised = sanitise(block, ctx);
  if ("ok" in sanitised) {
    return sanitised;
  }
  const { clean, cells: cleaned, text } = sanitised;
  const drop = (reason: BlockDropReason): DroppedBlock => ({
    ok: false,
    reason,
    block: clean,
  });
  const structural = block.kind === "heading" || block.kind === "tableHeader";
  const accept = (
    backing: AnswerCitation[],
    modelCited: boolean
  ): AcceptedBlock => ({
    ok: true,
    block: clean,
    citations: uniqueCitations(backing),
    modelCited,
  });

  if (structural) {
    return isLabel(text, ctx, HEADING_MIN_WORD_LENGTH) &&
      !IMPERATIVE_WORDS.has(splitWords(text).find(Boolean) ?? "")
      ? accept([], false)
      : drop("structure");
  }

  const valid = citations.flatMap((c) => {
    const resolved = resolveCitation(c, ctx.sources);
    return resolved ? [resolved] : [];
  });
  // A verbatim copy of a sent section stands on its own, even when the
  // provider's citation points elsewhere (e.g. misattributed while streaming).
  const verbatimOr = (fallback: DroppedBlock): BlockVerdict => {
    const copied = findVerbatim(text, ctx);
    return copied ? accept([copied], false) : fallback;
  };
  if (valid.length > 0) {
    if (hasLongRun(text)) {
      return drop("unsupported");
    }
    const passages = valid.map((v) => toPassage(v.passage));
    // Only citations that supported something are returned with the block.
    const used = new Set<number>();
    if (block.kind === "tableRow") {
      const at = passages.findIndex((p, i) =>
        isRowSupported(cleaned, p, flatten(valid[i].passage))
      );
      if (at === -1) {
        return verbatimOr(
          drop(isComparison(text) ? "comparative" : "unsupported")
        );
      }
      used.add(at);
    } else {
      for (const sentence of sentencesOf(text)) {
        // A comparison must be stated by one passage, not pieced together.
        const comparison =
          isComparison(sentence) &&
          !ctx.flat.some((sections) => isWholeCopyIn(sentence, sections));
        const at = passages.findIndex(
          (p, i) =>
            isClaimSupported(sentence, p) &&
            (!comparison || isComparisonStated(sentence, valid[i].passage))
        );
        if (at !== -1) {
          used.add(at);
        } else if (!isGapStatement(sentence, ctx)) {
          return verbatimOr(drop(comparison ? "comparative" : "unsupported"));
        }
      }
    }
    if (used.size === 0) {
      // Only gap statements: releasable, but they back nothing.
      return accept([], false);
    }
    return accept(
      [...used].sort((a, b) => a - b).map((i) => valid[i].entry),
      true
    );
  }

  const copied = findVerbatim(text, ctx);
  if (copied) {
    return accept([copied], false);
  }
  if (
    block.kind !== "tableRow" &&
    (isLeadIn(text, ctx) ||
      sentencesOf(text).every((s) => isGapStatement(s, ctx)))
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
  if (SENTINEL_PATTERN.test(state.text)) {
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

/**
 * Verifies the blocks of one streamed answer in order, remembering what was
 * released: a table row is dropped (reason "table") unless its header was
 * released, and `finish` runs the final gate over the released blocks.
 *
 * Use exactly one `BlockSplitter` per verifier: table ids are counters local
 * to a splitter, so rows from a second splitter could match the wrong header.
 * A pipe row after a blank line is a paragraph, not a table row; it is
 * verified as a claim and rendered escaped.
 */
export class AnswerVerifier {
  /** The verdicts of every block released so far, in order. */
  public released: AcceptedBlock[] = [];

  /**
   * @param sources the sources that were sent, in order.
   * @param mode "compare" applies the comparison rules (see `verifyCompare`).
   */
  public constructor(sources: AnswerSource[], mode: AnswerMode = "answer") {
    this.prepared = prepareSources(sources);
    this.mode = mode;
  }

  /**
   * Verifies the next block.
   *
   * @param block the block, as produced by `BlockSplitter`.
   * @param citations the provider citations for the block.
   * @returns the verdict; release `blockToMarkdown(verdict.block)` only when ok.
   */
  public verify(
    block: Block,
    citations: ProviderCitation[] = block.citations
  ): BlockVerdict {
    if (this.mode === "compare") {
      return this.verifyCompare(block, citations);
    }
    const verdict = verifyBlock(block, citations, this.prepared);
    if (block.kind === "tableRow" && !this.tables.has(block.tableId)) {
      return { ok: false, reason: "table", block: verdict.block };
    }
    if (verdict.ok) {
      if (block.kind === "tableHeader") {
        this.tables.add(block.tableId);
      }
      this.released.push(verdict);
    }
    return verdict;
  }

  /**
   * Runs the final gate over the released blocks.
   *
   * @param finishReason why generation stopped.
   * @param text everything the model generated, released or not.
   * @returns ok, or the reason the answer failed.
   */
  public finish(finishReason: FinishReason, text: string): FinalVerdict {
    return verifyFinal({ finishReason, text, released: this.released });
  }

  private prepared: PreparedSources;
  private tables = new Set<number>();
  private mode: AnswerMode;
  /** Set by the first table header of a comparison, released or not. */
  private comparison?: { tableId: number; columns?: number[] };

  /**
   * Comparison rules: one table whose header is a structural label and the
   * exact titles of two or three distinct sources; each body row an aspect
   * label from the sources' vocabulary and, per source column, an em dash or
   * a near-verbatim value backed by a cited passage of that column's source
   * only (else the whole row is dropped). Outside the table only statements
   * of what the documents do not cover are released. Rows of a dropped or
   * second header are dropped.
   */
  private verifyCompare(
    block: Block,
    citations: ProviderCitation[]
  ): BlockVerdict {
    let verdict: BlockVerdict;
    if (block.kind === "tableHeader") {
      if (this.comparison) {
        return dropEmptied(block, "table");
      }
      const header = verifyCompareHeader(block, this.prepared);
      this.comparison = { tableId: block.tableId, columns: header.columns };
      verdict = header.verdict;
    } else if (block.kind === "tableRow") {
      const columns =
        this.comparison?.tableId === block.tableId
          ? this.comparison.columns
          : undefined;
      if (!columns) {
        return dropEmptied(block, "table");
      }
      verdict = verifyCompareRow(block, citations, this.prepared, columns);
    } else if (block.kind === "paragraph") {
      verdict = verifyCompareGap(block, this.prepared);
    } else {
      return dropEmptied(block, "structure");
    }
    if (verdict.ok) {
      this.released.push(verdict);
    }
    return verdict;
  }
}

/** Matches the abstention sentinel, also when Markdown-escaped. */
const SENTINEL_PATTERN = /NO\\?_ANSWER/;

/** Longest block verified; longer ones are dropped before any pattern runs. */
const MAX_BLOCK_LENGTH = 4000;

/** Longest uncited heading, table header or lead-in. */
const MAX_STRUCTURAL_LENGTH = 80;

/**
 * Heading and table-header words longer than this must all come from the
 * sources or the neutral vocabulary; shorter ones are mostly function words.
 */
const HEADING_MIN_WORD_LENGTH = 3;

/** Instructions are not labels: a heading may not start with one of these. */
const IMPERATIVE_WORDS = new Set(
  (
    "use run install configure disable enable set reset delete remove send share click open go visit email " +
    "contact call change update download upload add create turn stop start skip avoid ignore enter type paste " +
    "copy follow check make give tell ask reply log sign grant allow deny bypass export import transfer pay " +
    "buy submit approve reject first then next always never do don dont"
  ).split(" ")
);

/** More identical tokens in a row than this is padding, not prose. */
const MAX_REPEATED_TOKENS = 20;

/** Longest statement of what the documents do not cover. */
const MAX_GAP_LENGTH = 160;

/** Shortest code block released; shorter ones match almost anywhere. */
const MIN_CODE_LENGTH = 8;

/**
 * Words a heading or lead-in may use without them being in the sources;
 * they label structure and assert nothing.
 */
const STRUCTURAL_WORDS = (
  "overview summary details detail background introduction integrations integration steps " +
  "setup installation configuration usage example examples notes comparison differences " +
  "troubleshooting diagnosis causes fixes solutions requirements prerequisites options features " +
  "key points related information documents sources limitations known issues"
).replace(/\s+/g, " ");

/**
 * Scheme URLs, protocol-relative //host, script and data schemes, www. hosts
 * and scheme-less host/path addresses. Quantifiers are bounded.
 */
const ANY_URL_PATTERN =
  /(?:\b[a-z][a-z0-9+.-]{0,30}:\/\/|(?<![\w/:])\/\/(?=[\w-])|\b(?:javascript|data|vbscript|file):|\bwww\.|\b[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,10}\.[a-z]{2,24}\/)[^\s<>()[\]"'`]{0,2000}/gi;

/** Host names without a scheme or path, such as evil.example.com or évil.cöm. */
const BARE_DOMAIN_PATTERN =
  /(?<![\p{L}\p{N}-])[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){0,10}\.\p{L}{2,24}(?![\p{L}\p{N}-])/giu;

/** Spelled-out hosts: "evil dot com", "evil (dot) com". */
const DOT_WORD_PATTERN =
  /(?<![\p{L}\p{N}])[\p{L}\p{N}-]{1,63}\s{0,3}[[(]?dot[\])]?\s{0,3}\p{L}{2,24}(?![\p{L}\p{N}])/giu;

/**
 * Tokens that look like code: paths, flags (also single-dash), calls, member
 * access, assignments, and defanged hosts like evil[.]com or evil(dot)com.
 */
const CODE_LIKE_PATTERN =
  /[/\\{}$<>=~]|\w\.\w|--|::|\(\)|^-[A-Za-z]|\[\.\]|[[(]dot[\])]/i;

/** Shell commands; the command and the word after it must be in the passage. */
const COMMAND_WORDS = new Set(
  "sudo curl wget rm chmod chown bash sh zsh powershell ssh scp nc netcat eval exec".split(
    " "
  )
);

/** Abbreviations that look like member access but are prose. */
const PROSE_ABBREVIATIONS = /^(?:e\.g|i\.e|etc)\.?$/i;

/** Words that assert or flip a table cell; rows with them must be copied verbatim. */
const POLARITY_WORDS = new Set(
  "no not yes none never true false y n".split(" ").map(stem)
);

/** A fixed lead, then the object (group 1) of what is not covered. */
const GAP_PATTERN =
  /^(?:the\s+)?(?:provided\s+|available\s+)?(?:documents?|sources?|search results|knowledge base)\s+(?:provided\s+)?(?:do|does)\s*(?:not|n['’]t)\s+(?:cover|mention|describe|include|contain|explain|address|discuss|list|provide|detail)((?:\s+[\p{L}\p{N}'’-]+){1,6})\.?$/iu;

/** Words in the object that would let a gap statement carry a claim or an instruction. */
const GAP_BLOCKERS =
  /\b(?:but|however|although|though|instead|yet|because|since|while|whereas|therefore|so|that|which|and|or|nor|as|if|when|then|unless|until|before|after|should|must|need|can|is|are|was|were|tell|use|email|contact|disable|enable|set|run|not|no|never|to|any|only|without)\b|[—–,;:`]/i;

/** Actions (any form) that may not be the object of a gap statement. */
const GAP_ACTIONS =
  /(?<![\p{L}])(?:disabl|enabl|bypass|shar|reus|skip|delet|remov|turn|send|sent|reset|chang|grant|export|transfer|install|run|download|upload|click|open|visit|ignor|switch|kill|stop)/iu;

/** Most content words a gap statement's object may have. */
const MAX_GAP_OBJECT_WORDS = 2;

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
  const entry = citationFor(source, citation.sectionIndex, citation.quote);
  return { key: citationKey(entry), passage, entry };
}

function citationFor(
  source: AnswerSource,
  at: number,
  quote: string
): AnswerCitation {
  const anchor = source.anchors?.[at];
  const headingText = source.headings?.[at];
  return {
    documentId: source.document.id,
    title: source.document.title,
    url: source.document.url,
    heading: headingOf(source.sections[at]),
    ...(anchor ? { anchor } : {}),
    ...(headingText ? { headingText } : {}),
    quote: truncate(quote),
  };
}

function citationKey(citation: AnswerCitation): string {
  return `${citation.documentId}:${citation.anchor ?? citation.heading ?? ""}`;
}

/** Splits text into sentences and lines; an invented one must not ride along with a real one. */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => sentence.trim());
}

/** Normalised text with uniform spacing around table pipes. */
function flatten(value: string): string {
  return normalise(value).replace(/\s*\|\s*/g, " | ");
}

function trimLines(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

/** URLs, emails and bare domains, after folding look-alike dots (。．｡) to ".". */
function addressesIn(text: string): {
  urls: string[];
  emails: string[];
  domains: string[];
} {
  const probe = text.normalize("NFKC").replace(/[。．｡]/g, ".");
  const urls: string[] = probe.match(ANY_URL_PATTERN) ?? [];
  const emails: string[] = probe.match(EMAIL_PATTERN) ?? [];
  const rest = urls
    .concat(emails)
    .reduce((left, token) => left.replace(token, " "), probe);
  const domains: string[] = [
    ...(rest.match(BARE_DOMAIN_PATTERN) ?? []),
    ...(rest.match(DOT_WORD_PATTERN) ?? []),
  ];
  return { urls, emails, domains };
}

/**
 * Reduces model-written links to their text; rejects images, HTML, and any
 * link, image or reference syntax left over (nested or escaped brackets).
 */
function stripMarkup(text: string): string | { reason: BlockDropReason } {
  const outsideCode = (value: string) => value.replace(CODE_SPAN_PATTERN, " ");
  if (/!\[/.test(outsideCode(text))) {
    return { reason: "image" };
  }
  // Bounded: each pass removes at least one pair of brackets.
  for (let previous = ""; previous !== text;) {
    previous = text;
    text = text
      .replace(/\[([^[\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
      .replace(/\[([^[\]]*)\]\[[^\]]*\]/g, "$1");
  }
  if (/\][([:]/.test(outsideCode(text))) {
    return { reason: "link" };
  }
  if (/<[A-Za-z/!?]/.test(text)) {
    return { reason: "html" };
  }
  return text;
}

/** A section flattened line by line, remembering where lines start and end. */
interface FlatSection {
  text: string;
  /** Offsets where a line, or a list item's text after its marker, starts. */
  starts: Set<number>;
  /** Offsets where a line ends. */
  ends: Set<number>;
}

function flattenLines(section: string): FlatSection {
  let text = "";
  const starts = new Set<number>();
  const ends = new Set<number>();
  for (const line of section.split("\n")) {
    const flat = flatten(line);
    if (!flat) {
      continue;
    }
    if (text) {
      text += " ";
    }
    starts.add(text.length);
    starts.add(text.length + (LIST_MARKER.exec(flat)?.[0].length ?? 0));
    text += flat;
    ends.add(text.length);
  }
  return { text, starts, ends };
}

const LIST_MARKER = /^(?:[-+]|\d+[.)])\s+/;

/**
 * Whether `needle` at `start` is a whole unit of the section: it begins at a
 * line, list item, table cell or sentence start and ends at a sentence end or
 * the end of a line or cell. A plain substring could cut a negation away
 * ("Never run X." -> "Run X.").
 */
function isBounded(section: FlatSection, start: number, needle: string) {
  const end = start + needle.length;
  const startsWell =
    start === 0 ||
    section.starts.has(start) ||
    /[.!?:;|]$/.test(
      section.text.slice(Math.max(0, start - 3), start).trimEnd()
    );
  const endsWell =
    end === section.text.length ||
    section.ends.has(end) ||
    /[.!?;:]$/.test(needle) ||
    /^\s*[.!?;|]/.test(section.text.slice(end, end + 3));
  return startsWell && endsWell;
}

/** Copied text as compared with a flattened section, list marker removed. */
function verbatimNeedle(text: string): string {
  return flatten(text).replace(LIST_MARKER, "");
}

/** Whether the needle occurs in the section as a whole, bounded unit. */
function containsWhole(section: FlatSection, needle: string): boolean {
  for (
    let start = section.text.indexOf(needle);
    start !== -1;
    start = section.text.indexOf(needle, start + 1)
  ) {
    if (isBounded(section, start, needle)) {
      return true;
    }
  }
  return false;
}

/** An uncited block counts as a source copy when it is long, verbatim and whole. */
function findVerbatim(
  text: string,
  ctx: PreparedSources
): AnswerCitation | undefined {
  const needle = verbatimNeedle(text);
  if (needle.length < MIN_GROUNDED_LENGTH) {
    return undefined;
  }
  for (const [i, source] of ctx.sources.entries()) {
    const at = ctx.flat[i].findIndex((section) =>
      containsWhole(section, needle)
    );
    if (at !== -1) {
      return citationFor(source, at, text);
    }
  }
  return undefined;
}

/**
 * Whether every code-like token in the text appears in the normalised
 * passage; a shell command word and the word after it count as code-like.
 */
function codeLikeTokensKnown(text: string, passage: string): boolean {
  const tokens = text
    .split(/\s+/)
    .map((token) => token.replace(/^[[("'`*]+|[\])"'`*.,;:!?]+$/g, ""));
  return tokens.every((token, i) => {
    const command =
      COMMAND_WORDS.has(token.toLowerCase()) ||
      COMMAND_WORDS.has(tokens[i - 1]?.toLowerCase() ?? "");
    const codeLike =
      command ||
      (CODE_LIKE_PATTERN.test(token) && !PROSE_ABBREVIATIONS.test(token));
    return !codeLike || !token || containsToken(passage, normalise(token));
  });
}

/** A claim sentence supported by one cited passage. */
function isClaimSupported(sentence: string, passage: Passage): boolean {
  return (
    (supportRatio(sentence, passage, true) ?? 0) >= MIN_CONTENT_WORD_SUPPORT &&
    codeLikeTokensKnown(sentence, passage.text)
  );
}

/**
 * A table row whose cells and whole row are supported by one cited passage.
 * A row with yes/no-type words or a cell without letters or digits (✓, ❌,
 * empty) must be copied verbatim, cells in order, from that passage.
 */
function isRowSupported(
  cells: string[],
  passage: Passage,
  flatPassage: string
): boolean {
  const filled = cells.filter((c) => c.trim());
  const row = filled.join(" ");
  if (
    cells.some((cell) => !/[\p{L}\p{N}]/u.test(cell)) ||
    splitWords(row).some((w) => POLARITY_WORDS.has(stem(w))) ||
    isComparison(row)
  ) {
    return flatPassage.includes(flatten(`| ${cells.join(" | ")} |`));
  }
  return (
    filled.every((cell) => isClaimSupported(cell, passage)) &&
    isClaimSupported(row, passage)
  );
}

/**
 * A short label that carries no claim the sources do not make: no URL or
 * email, known exact and code-like tokens, and every content word longer than
 * `minWordLength` from the sent sections or the neutral vocabulary.
 */
function isLabel(
  text: string,
  ctx: PreparedSources,
  minWordLength: number
): boolean {
  const found = addressesIn(text);
  if (
    text.length > MAX_STRUCTURAL_LENGTH ||
    found.urls.length > 0 ||
    found.emails.length > 0 ||
    !codeLikeTokensKnown(text, ctx.known.text)
  ) {
    return false;
  }
  const prose = proseIfExactTokensIn(text, ctx.labels.folded);
  return (
    prose !== undefined &&
    splitWords(prose)
      .filter((w) => w.length > minWordLength && !STOPWORDS.has(w))
      .every((w) => ctx.labels.words.has(stem(w)))
  );
}

/** A one-line lead-in to a list, table or code block, every word from the sources. */
function isLeadIn(text: string, ctx: PreparedSources): boolean {
  return (
    text.endsWith(":") &&
    sentencesOf(text).length === 1 &&
    !isComparison(text) &&
    isLabel(text, ctx, 0)
  );
}

/** More than `MAX_REPEATED_TOKENS` identical whitespace-separated tokens in a row. */
function hasLongRun(text: string): boolean {
  let run = 0;
  let previous = "";
  for (const token of text.split(/\s+/)) {
    run = token === previous ? run + 1 : 1;
    previous = token;
    if (run > MAX_REPEATED_TOKENS) {
      return true;
    }
  }
  return false;
}

/**
 * A plain statement of what the sources do not cover: a fixed lead and a
 * short object with no digits, addresses, code, clauses or instructions.
 */
function isGapStatement(sentence: string, ctx: PreparedSources): boolean {
  const text = sentence.trim();
  const object =
    text.length <= MAX_GAP_LENGTH ? text.match(GAP_PATTERN)?.[1] : undefined;
  if (!object) {
    return false;
  }
  const found = addressesIn(text);
  return (
    !GAP_BLOCKERS.test(object) &&
    !GAP_ACTIONS.test(object) &&
    splitWords(object).filter((w) => w && !STOPWORDS.has(w)).length <=
      MAX_GAP_OBJECT_WORDS &&
    !/\p{N}/u.test(text) &&
    found.urls.length + found.emails.length + found.domains.length === 0 &&
    !text.split(/\s+/).some((t) => CODE_LIKE_PATTERN.test(t)) &&
    proseIfExactTokensIn(text, ctx.known.folded) !== undefined
  );
}

/**
 * Whether code is copied as whole lines (indentation aside) or as one whole
 * inline code span. A part of a line could drop the comment or flag that
 * changes what the line does.
 */
function isWholeCode(section: string, code: string): boolean {
  if (!code.includes("\n") && section.includes(`\`${code}\``)) {
    return true;
  }
  for (
    let start = section.indexOf(code);
    start !== -1;
    start = section.indexOf(code, start + 1)
  ) {
    const end = start + code.length;
    if (
      /(?:^|\n)[ \t]*$/.test(section.slice(0, start)) &&
      (end === section.length || section[end] === "\n")
    ) {
      return true;
    }
  }
  return false;
}

/** A code block must be copied verbatim from a sent section. */
function verifyCode(block: Block, ctx: PreparedSources): BlockVerdict {
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
  if (SENTINEL_PATTERN.test(text)) {
    return { ok: false, reason: "sentinel", block: clean };
  }
  if (text.trim().length < MIN_CODE_LENGTH) {
    return { ok: false, reason: "code", block: clean };
  }
  for (const [i, source] of ctx.sources.entries()) {
    const at = ctx.code[i].findIndex((s) => isWholeCode(s, text));
    if (at !== -1) {
      return {
        ok: true,
        block: clean,
        citations: [citationFor(source, at, text)],
        modelCited: false,
      };
    }
  }
  return { ok: false, reason: "code", block: clean };
}

/** Whether a block is over the length cap, checked before any pattern runs. */
function isTooLong(block: Block): boolean {
  return (
    block.text.length > MAX_BLOCK_LENGTH ||
    block.cells.join("").length > MAX_BLOCK_LENGTH ||
    block.text.normalize("NFKC").length > MAX_BLOCK_LENGTH
  );
}

/** A dropped block with its content removed, for blocks never inspected. */
function dropEmptied(block: Block, reason: BlockDropReason): DroppedBlock {
  return {
    ok: false,
    reason,
    block: { ...block, text: "", cells: [], inlineCode: [] },
  };
}

function uniqueCitations(backing: AnswerCitation[]): AnswerCitation[] {
  return [...new Map(backing.map((c) => [citationKey(c), c])).values()];
}

/** A non-code block after redaction and markup stripping. */
interface SanitisedBlock {
  clean: Block;
  /** The cleaned cells of a table row; empty otherwise. */
  cells: string[];
  /** The cleaned visible text. */
  text: string;
}

/**
 * Redacts a non-code block, reduces model-written links to their text and
 * drops it for the sentinel, images, leftover link syntax, HTML, no letters or
 * digits, and URLs, emails or bare domains not in the sent sections (any URL
 * or email in a heading or table header).
 */
function sanitise(
  block: Block,
  ctx: PreparedSources
): SanitisedBlock | DroppedBlock {
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
  if (SENTINEL_PATTERN.test(redacted.text)) {
    return drop("sentinel");
  }

  const table = block.kind === "tableHeader" || block.kind === "tableRow";
  const cleaned: string[] = [];
  for (const part of table ? redacted.cells : [redacted.text]) {
    const result = stripMarkup(part);
    if (typeof result !== "string") {
      return drop(result.reason);
    }
    cleaned.push(result);
  }
  const text = table ? cleaned.join(" | ") : cleaned[0];
  const clean: Block = {
    ...redacted,
    text,
    cells: table ? cleaned : [],
    inlineCode: [...text.matchAll(CODE_SPAN_PATTERN)].map((m) => m[1]),
  };

  if (!/[\p{L}\p{N}]/u.test(text)) {
    return drop("empty");
  }
  const structural = block.kind === "heading" || block.kind === "tableHeader";
  const found = addressesIn(text);
  const isNovel = (token: string) =>
    !containsToken(ctx.known.text, normalise(token.replace(/[.,;:!?]+$/, "")));
  if (found.urls.some((url) => structural || isNovel(url))) {
    return drop("url");
  }
  if (found.emails.some((email) => structural || isNovel(email))) {
    return drop("email");
  }
  if (found.domains.some(isNovel)) {
    return drop("url");
  }
  return { clean, cells: cleaned, text };
}

/** Labels a comparison table's first header cell may use. */
const COMPARE_LABELS = new Set(
  "aspect aspects item topic feature field detail property setting rule criterion attribute".split(
    " "
  )
);

/** The em dash a comparison cell holds when its source has no value. */
const EMPTY_CELL = "—";

/** Longest value in a comparison cell. */
const MAX_COMPARE_CELL_LENGTH = 200;

/**
 * Words that compare, rank or derive; a comparison cell or aspect with one
 * must be copied whole from a source.
 */
const COMPARATIVE_WORDS = new Set(
  (
    "more less least most higher highest lower lowest greater greatest fewer fewest better best worse worst " +
    "cheaper cheapest costlier pricier dearer larger largest smaller smallest bigger biggest longer shorter " +
    "faster slower stricter looser stronger weaker newer older earlier later than difference differences " +
    "differ differs different vs versus halve halves halved double doubles doubled triple triples tripled " +
    "twice increase increases increased decrease decreases decreased reduce reduces reduced exceed exceeds " +
    "compared comparison unlike whereas same unchanged both"
  ).split(" ")
);

/**
 * Comparative words that make a sentence a comparison or a ranking: "than",
 * "versus", "compared" and superlatives. A bare "more" ("more details are in
 * X") compares nothing and is left to the ordinary support check.
 */
const COMPARISON_TRIGGERS = new Set(
  [...COMPARATIVE_WORDS].filter(
    (word) =>
      word.endsWith("est") ||
      ["than", "vs", "versus", "compared", "unlike", "most", "worst"].includes(
        word
      )
  )
);

/** Triggers whose two sides keep their order ("A costs more than B"). */
const ORDERED_TRIGGERS = new Set([
  "than",
  "vs",
  "versus",
  "compared",
  "unlike",
]);

/** How many words either side of a trigger the compared things may be. */
const COMPARISON_WINDOW = 12;

/** Words of the text outside inline code and code-like tokens. */
function proseWords(text: string): string[] {
  const prose = text
    .replace(CODE_SPAN_PATTERN, " ")
    .split(/\s+/)
    .filter((token) => !CODE_LIKE_PATTERN.test(token))
    .join(" ");
  return splitWords(prose).filter(Boolean);
}

/** Positions of comparison triggers; "at least" and "at most" bound a quantity. */
function triggersIn(words: string[]): number[] {
  return words.flatMap((word, i) =>
    COMPARISON_TRIGGERS.has(word) && words[i - 1] !== "at" ? [i] : []
  );
}

/** Stemmed content words, the comparison triggers left out. */
function comparedWords(words: string[]): string[] {
  return words
    .filter((w) => !STOPWORDS.has(w) && !COMPARISON_TRIGGERS.has(w))
    .map(stem);
}

/** Whether the text compares or ranks things. */
function isComparison(text: string): boolean {
  return triggersIn(proseWords(text)).length > 0;
}

/**
 * Whether one clause of the passage states the sentence's comparison: for
 * each trigger, the same word with every content word before it in the
 * sentence within `COMPARISON_WINDOW` words before it and every content word
 * after it within the window after it; a superlative's words may be on
 * either side.
 */
function isComparisonStated(sentence: string, passage: string): boolean {
  const words = proseWords(sentence);
  const clauses = passage.split(/[!?;|\n]|[.:](?=\s|$)/).map(proseWords);
  return triggersIn(words).every((t) => {
    const before = comparedWords(words.slice(0, t));
    const after = comparedWords(words.slice(t + 1));
    return clauses.some((clause) =>
      triggersIn(clause).some((p) => {
        if (clause[p] !== words[t]) {
          return false;
        }
        const left = new Set(
          comparedWords(clause.slice(Math.max(0, p - COMPARISON_WINDOW), p))
        );
        const right = new Set(
          comparedWords(clause.slice(p + 1, p + 1 + COMPARISON_WINDOW))
        );
        return ORDERED_TRIGGERS.has(words[t])
          ? before.every((w) => left.has(w)) && after.every((w) => right.has(w))
          : [...before, ...after].every((w) => left.has(w) || right.has(w));
      })
    );
  });
}

/** Arrows, inequality signs, deltas and strikethrough that state a change. */
const COMPARATIVE_SYMBOLS = /[→←⇒⇐↑↓<>±Δ]|->|~~/u;

/** A source's title as the client shows it and a comparison header must copy. */
function compareTitle(source: AnswerSource): string {
  return normalise(redactSecrets(source.document.title || "Untitled").text);
}

function hasComparative(text: string): boolean {
  return (
    COMPARATIVE_SYMBOLS.test(text) ||
    splitWords(text).some((word) => COMPARATIVE_WORDS.has(word))
  );
}

function hasPolarity(text: string): boolean {
  return splitWords(text).some((word) => POLARITY_WORDS.has(stem(word)));
}

/** Whether the text is a whole, bounded unit of one of the sections. */
function isWholeCopyIn(text: string, sections: FlatSection[]): boolean {
  const needle = verbatimNeedle(text);
  return !!needle && sections.some((section) => containsWhole(section, needle));
}

/**
 * The header of a comparison: a structural label, then the exact titles of
 * two or three distinct sources, which become the columns.
 */
function verifyCompareHeader(
  block: Block,
  ctx: PreparedSources
): { verdict: BlockVerdict; columns?: number[] } {
  if (isTooLong(block)) {
    return { verdict: dropEmptied(block, "long") };
  }
  const sanitised = sanitise(block, ctx);
  if ("ok" in sanitised) {
    return { verdict: sanitised };
  }
  const drop = {
    verdict: {
      ok: false as const,
      reason: "structure" as const,
      block: sanitised.clean,
    },
  };
  const [label, ...titles] = sanitised.cells.map(normalise);
  if (
    titles.length < 2 ||
    titles.length > MAX_COMPARE_SOURCES ||
    !COMPARE_LABELS.has(label)
  ) {
    return drop;
  }
  const known = ctx.sources.map(compareTitle);
  const columns: number[] = [];
  for (const title of titles) {
    const matches = known.flatMap((t, i) => (t === title ? [i] : []));
    // An ambiguous or repeated title cannot tell which document a column is.
    if (matches.length !== 1 || columns.includes(matches[0])) {
      return drop;
    }
    columns.push(matches[0]);
  }
  return {
    verdict: {
      ok: true,
      block: sanitised.clean,
      citations: [],
      modelCited: false,
    },
    columns,
  };
}

/** A resolved citation of a comparison row, kept with its source. */
interface CompareCitation {
  sourceIndex: number;
  entry: AnswerCitation;
  passage: Passage;
  sections: FlatSection[];
}

/**
 * A comparison body row: an aspect label, then per column an em dash or a
 * value supported by a cited passage of that column's source. One cell that
 * fails drops the row.
 */
function verifyCompareRow(
  block: Block,
  citations: ProviderCitation[],
  ctx: PreparedSources,
  columns: number[]
): BlockVerdict {
  if (isTooLong(block)) {
    return dropEmptied(block, "long");
  }
  const sanitised = sanitise(block, ctx);
  if ("ok" in sanitised) {
    return sanitised;
  }
  const drop = (reason: BlockDropReason): DroppedBlock => ({
    ok: false,
    reason,
    block: sanitised.clean,
  });
  const [aspect, ...values] = sanitised.cells.map((cell) => cell.trim());
  if (values.length !== columns.length || hasLongRun(sanitised.text)) {
    return drop("structure");
  }
  if (!isAspectLabel(aspect, ctx)) {
    return drop("structure");
  }
  const valid: CompareCitation[] = citations.flatMap((c) => {
    const resolved = resolveCitation(c, ctx.sources);
    return resolved
      ? [
          {
            sourceIndex: c.sourceIndex,
            entry: resolved.entry,
            passage: toPassage(resolved.passage),
            sections: ctx.flat[c.sourceIndex].slice(
              c.sectionIndex,
              c.endSectionIndex
            ),
          },
        ]
      : [];
  });
  const backing: AnswerCitation[] = [];
  for (const [i, value] of values.entries()) {
    if (value === EMPTY_CELL) {
      continue;
    }
    // Only a passage of this column's own document may back its cell.
    const support = valid.find(
      (c) => c.sourceIndex === columns[i] && isCellSupported(value, c)
    );
    if (!support) {
      return drop(valid.length > 0 ? "unsupported" : "uncited");
    }
    backing.push(support.entry);
  }
  if (backing.length === 0) {
    return drop("unsupported");
  }
  return {
    ok: true,
    block: sanitised.clean,
    citations: uniqueCitations(backing),
    modelCited: true,
  };
}

/**
 * An aspect label: a label whose every word comes from the sent sections or
 * the structural vocabulary, not an instruction, and without comparative words
 * unless copied whole from a section.
 */
function isAspectLabel(text: string, ctx: PreparedSources): boolean {
  return (
    isLabel(text, ctx, 0) &&
    !IMPERATIVE_WORDS.has(splitWords(text).find(Boolean) ?? "") &&
    (!hasComparative(text) || ctx.flat.some((s) => isWholeCopyIn(text, s)))
  );
}

/**
 * A near-verbatim value: short, with letters or digits, every word (function
 * words too) and every number, URL, email, code-like token and acronym in the
 * cited passage; yes/no words, comparative words and symbols such as ✓ only
 * in a whole copy of a cited section.
 */
function isCellSupported(value: string, citation: CompareCitation): boolean {
  const { passage } = citation;
  if (
    value.length > MAX_COMPARE_CELL_LENGTH ||
    !/[\p{L}\p{N}]/u.test(value) ||
    supportRatio(value, passage, true) !== 1 ||
    !splitWords(value)
      .filter(Boolean)
      .every((word) => passage.words.has(stem(word))) ||
    !codeLikeTokensKnown(value, passage.text)
  ) {
    return false;
  }
  return (
    !(
      hasComparative(value) ||
      hasPolarity(value) ||
      /[\p{So}\p{Sm}]/u.test(value)
    ) || isWholeCopyIn(value, citation.sections)
  );
}

/** Outside the comparison table only "not covered" statements are released. */
function verifyCompareGap(block: Block, ctx: PreparedSources): BlockVerdict {
  if (isTooLong(block)) {
    return dropEmptied(block, "long");
  }
  const sanitised = sanitise(block, ctx);
  if ("ok" in sanitised) {
    return sanitised;
  }
  return sentencesOf(sanitised.text).every((s) => isGapStatement(s, ctx))
    ? { ok: true, block: sanitised.clean, citations: [], modelCited: false }
    : { ok: false, reason: "unsupported", block: sanitised.clean };
}
