import type { AnswerSegment, Turn } from "./model";
import {
  answerSegments,
  citedSources,
  isActive,
  sectionHeading,
} from "./model";

type Block = Turn["blocks"][number];

// Headings and table headers frame an answer; they make no claim of their own.
const CLAIM_KINDS: Block["kind"][] = [
  "paragraph",
  "listItem",
  "tableRow",
  "code",
];

/** What the data held for a finished answer supports saying about it. */
export type Verification =
  | {
      state: "verified";
      /** Distinct sources cited by the shown answer. */
      cited: number;
      /** Every released claim block carries a citation (no uncited gap statement). */
      everyCited: boolean;
    }
  | { state: "partial" }
  /** Finished, but the verifier left some statements out. */
  | { state: "trimmed" };

/**
 * The calm verification line for a turn, from data the reducer already holds.
 * Only released (verified) blocks are ever shown, so a finished answer with
 * blocks and no failure is "verified"; a failed, stopped or cut-short one with
 * blocks is "partial", and one where the verifier dropped statements is
 * "trimmed". "Every statement cited" is only claimed when nothing was dropped
 * and every released claim block has a citation. Nothing is claimed while
 * streaming or without blocks.
 *
 * @param turn the turn.
 * @returns the line to show, or undefined when there is nothing to claim.
 */
export function verificationOf(turn: Turn): Verification | undefined {
  if (isActive(turn) || turn.blocks.length === 0) {
    return undefined;
  }
  if (turn.problem || turn.status !== "done") {
    return { state: "partial" };
  }
  if (turn.droppedSegments) {
    return { state: "trimmed" };
  }
  return {
    state: "verified",
    cited: citedSources(turn).length,
    everyCited: turn.blocks
      .filter((b) => CLAIM_KINDS.includes(b.kind))
      .every((b) => b.citations.length > 0),
  };
}

/** What the Sources panel's banner may say about how well the answer is covered. */
export type Coverage =
  | { kind: "all"; statements: number; documents: number }
  /** Part of the question is not covered by the documents. */
  | { kind: "gap" }
  | { kind: "dropped" }
  | { kind: "partial" };

/**
 * The coverage banner of the Sources panel. "All N statements match a passage"
 * is claimed only when nothing was dropped, nothing failed and no gap
 * statement is present; N counts the cited claim blocks actually released.
 *
 * @param turn the turn.
 * @returns the banner, or undefined when there is nothing to claim.
 */
export function coverageOf(turn: Turn): Coverage | undefined {
  const verification = verificationOf(turn);
  if (!verification || isNotCovered(turn)) {
    return undefined;
  }
  if (verification.state === "partial") {
    return { kind: "partial" };
  }
  if (verification.state === "trimmed") {
    return { kind: "dropped" };
  }
  if (gapBlocks(turn).length > 0) {
    return { kind: "gap" };
  }
  const statements = turn.blocks.filter(
    (b) => CLAIM_KINDS.includes(b.kind) && b.citations.length > 0
  ).length;
  return statements > 0
    ? { kind: "all", statements, documents: verification.cited }
    : undefined;
}

// The verifier's fixed lead for "what the documents do not cover".
const GAP_LEAD =
  /^(?:the\s+)?(?:provided\s+|available\s+)?(?:documents?|sources?|search results|knowledge base)\s+(?:provided\s+)?(?:do|does)\s*(?:not|n['’]t)\s+\p{L}+/iu;

/**
 * Whether a finished turn did not find an answer in the documents: it ended
 * `no_answer`, or every shown block is an uncited gap statement.
 *
 * @param turn the turn.
 * @returns true when the "not covered" notice applies.
 */
export function isNotCovered(turn: Turn): boolean {
  if (isActive(turn)) {
    return false;
  }
  if (turn.problem === "no_answer") {
    return true;
  }
  return (
    turn.status === "done" &&
    !turn.problem &&
    turn.blocks.length > 0 &&
    turn.blocks.every(isGapBlock)
  );
}

/**
 * Whether a block is a gap statement: an uncited paragraph that opens with the
 * verifier's fixed "The documents do not cover …" lead.
 *
 * @param block the block.
 * @returns true for a gap statement.
 */
export function isGapBlock(block: Block): boolean {
  return (
    block.kind === "paragraph" &&
    block.citations.length === 0 &&
    GAP_LEAD.test(block.markdown.trim())
  );
}

/**
 * The gap statements of an answer, in order.
 *
 * @param turn the turn.
 * @returns the blocks that say what the documents do not cover.
 */
export function gapBlocks(turn: Turn): Block[] {
  return turn.blocks.filter(isGapBlock);
}

/** A part of an answer: normal blocks, a gap statement or a withheld stretch. */
export type AnswerPart =
  | { type: "blocks"; blocks: Block[] }
  | { type: "gap"; block: Block }
  | Extract<AnswerSegment, { type: "hidden" }>;

/**
 * Splits an answer into parts so gap statements can be shown as calm notices
 * instead of prose. Gap statements are left out when `withoutGaps` is set (the
 * caller shows them in its own card).
 *
 * @param turn the turn.
 * @param withoutGaps drop the gap statements from the parts.
 * @returns the parts in reading order.
 */
export function answerParts(turn: Turn, withoutGaps = false): AnswerPart[] {
  const parts: AnswerPart[] = [];
  for (const segment of answerSegments(turn)) {
    if (segment.type === "hidden") {
      parts.push(segment);
      continue;
    }
    let run: Block[] = [];
    const flush = () => {
      if (run.length) {
        parts.push({ type: "blocks", blocks: run });
        run = [];
      }
    };
    for (const block of segment.blocks) {
      if (!isGapBlock(block)) {
        run.push(block);
        continue;
      }
      flush();
      if (!withoutGaps) {
        parts.push({ type: "gap", block });
      }
    }
    flush();
  }
  return parts;
}

/** A follow-up the user can pick; the label is composed by the UI. */
export type FollowUp = { kind: "more"; heading: string } | { kind: "compare" };

const MAX_HEADINGS = 3;

/**
 * Follow-up suggestions from the cited sources, without a model call: up to
 * three "tell me more" chips from distinct cited section headings, plus a
 * comparison chip when two or more sources are cited.
 *
 * @param turn the turn.
 * @returns the suggestions, empty for unfinished or uncited answers.
 */
export function followUpSuggestions(turn: Turn): FollowUp[] {
  if (turn.status !== "done" || turn.problem) {
    return [];
  }
  const sources = citedSources(turn);
  const seen = new Set<string>();
  const out: FollowUp[] = [];
  for (const source of sources) {
    for (const section of source.sections) {
      const heading = sectionHeading(section);
      const key = heading?.toLowerCase();
      if (heading && key && !seen.has(key) && seen.size < MAX_HEADINGS) {
        seen.add(key);
        out.push({ kind: "more", heading });
      }
    }
  }
  if (sources.length >= 2) {
    out.push({ kind: "compare" });
  }
  return out;
}
