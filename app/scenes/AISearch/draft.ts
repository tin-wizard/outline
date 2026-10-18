import { turnToMarkdown } from "./exportMarkdown";
import type { Turn } from "./model";

/** Longest title a saved draft gets. */
export const MAX_DRAFT_TITLE = 100;

/** What `documents.create` receives to save an answer as a draft. */
export interface Draft {
  title: string;
  text: string;
}

function titleFrom(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DRAFT_TITLE
    ? flat.slice(0, MAX_DRAFT_TITLE - 1).trimEnd() + "…"
    : flat;
}

/**
 * Builds the draft for one finished answer: the question as title, the
 * verifier-released blocks as text and the numbered Sources list (links only
 * for safe document paths). Nothing else from the model is ever included.
 *
 * @param turn the turn to save.
 * @param origin absolute origin for source links; the page origin by default.
 * @returns the draft, or undefined when the turn has no released answer.
 */
export function turnDraft(turn: Turn, origin?: string): Draft | undefined {
  if (turn.status !== "done" || !turn.blocks.length) {
    return undefined;
  }
  return {
    title: titleFrom(turn.question),
    text: turnToMarkdown(turn, {
      includeQuestion: false,
      includeSources: true,
      origin,
    }),
  };
}

/**
 * Builds the draft for a whole conversation: each answered question quoted
 * above its answer. Turns without a released answer are left out.
 *
 * @param turns all turns of the chat.
 * @param title the chat title, used as the draft title.
 * @param origin absolute origin for source links; the page origin by default.
 * @returns the draft, or undefined when no turn has an answer.
 */
export function conversationDraft(
  turns: Turn[],
  title: string,
  origin?: string
): Draft | undefined {
  const answered = turns.filter(
    (turn) => turn.status === "done" && turn.blocks.length > 0
  );
  if (!answered.length) {
    return undefined;
  }
  return {
    title: titleFrom(title || answered[0].question),
    text: answered
      .map((turn) =>
        turnToMarkdown(turn, {
          includeQuestion: true,
          includeSources: true,
          origin,
        })
      )
      .join("\n\n---\n\n"),
  };
}
