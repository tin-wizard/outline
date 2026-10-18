import type { Turn } from "./model";
import { citedSources, isActive, sectionHeading } from "./model";

/** What the data held for a finished answer supports saying about it. */
export type Verification =
  | {
      state: "verified";
      /** Documents retrieved for the answer; undefined when not known. */
      documents?: number;
      /** Distinct sources cited by the shown answer. */
      cited: number;
    }
  | { state: "partial" }
  /** Finished, but the verifier left some statements out. */
  | { state: "trimmed" };

/**
 * The calm verification line for a turn, from data the reducer already holds.
 * Only released (verified) blocks are ever shown, so a finished answer with
 * blocks and no failure is "verified"; a failed, stopped or cut-short one with
 * blocks is "partial", and one where the verifier dropped statements is "trimmed". Nothing is claimed while streaming or without blocks.
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
    documents: turn.sources?.length || undefined,
    cited: citedSources(turn).length,
  };
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
    turn.blocks.every(
      (b) =>
        b.kind === "paragraph" &&
        b.citations.length === 0 &&
        GAP_LEAD.test(b.markdown.trim())
    )
  );
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
