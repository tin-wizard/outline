import { isUUID } from "validator";
import type {
  AskCitation,
  AskEvent,
  AskFailure,
  AskSource,
} from "~/utils/streamFetch";
import type { BlockInput } from "./markdown";

/** Why a turn did not produce a complete answer. */
export type TurnProblem =
  | AskFailure
  | "unauthorized"
  | "forbidden"
  | "rateLimited"
  | "network";

export type TurnStatus =
  | "searching"
  | "generating"
  | "done"
  | "failed"
  | "stopped";

export type Rating = "up" | "down";

export interface Feedback {
  /** The current rating, null when none (or cleared). */
  rating: Rating | null;
  /** The rating before the in-flight request, restored if it fails. */
  previous: Rating | null;
  /** A request is in flight: the buttons are disabled. */
  pending: boolean;
  /** Set after a successful request, for the "Thanks" announcement. */
  saved?: boolean;
  error?: "failed" | "rateLimited";
  /** The server refused (403/404): the buttons are hidden. */
  hidden?: boolean;
}

export interface Scope {
  collectionId?: string;
  documentId?: string;
}

export interface Turn {
  /** Increasing id, stable for React keys. */
  id: number;
  question: string;
  /** The scope this question was searched with. */
  scope: Scope;
  status: TurnStatus;
  /** A server notice code, such as `conversation_new`; mapped to text by the UI. */
  notice?: string;
  /** Retrieved sources; null until the `sources` event. */
  sources: AskSource[] | null;
  blocks: (BlockInput & { index: number })[];
  problem?: TurnProblem;
  /** Id of the metered usage row, needed to send feedback; null if not recorded. */
  usageId?: string | null;
  /** Helpful / not helpful state of a finished answer. */
  feedback?: Feedback;
  /** Seconds the server asked us to wait after a 429. */
  retryAfter?: number;
}

export interface ChatState {
  /** Sent with follow-ups; null for the first question or an unstored turn. */
  conversationId: string | null;
  turns: Turn[];
}

export type ChatAction =
  | { type: "submit"; question: string; scope: Scope }
  | { type: "event"; event: AskEvent }
  | { type: "requestFailed"; problem: TurnProblem; retryAfter?: number }
  | { type: "feedbackStart"; turnId: number; rating: Rating | null }
  | { type: "feedbackDone"; turnId: number }
  | {
      type: "feedbackFailed";
      turnId: number;
      error: "failed" | "rateLimited" | "refused";
    }
  | { type: "stopped" }
  | { type: "ended" }
  | { type: "reset" };

export const initialChatState: ChatState = { conversationId: null, turns: [] };

/**
 * Whether a turn is still waiting for the server.
 *
 * @param turn the turn, if any.
 * @returns true while searching or writing.
 */
export function isActive(turn: Turn | undefined): boolean {
  return turn?.status === "searching" || turn?.status === "generating";
}

/**
 * Collects the sources cited by an answer, in citation order, preferring the
 * retrieved source's collection name and the first citation's section link.
 *
 * @param turn the turn.
 * @returns one entry per cited source number.
 */
export function citedSources(turn: Turn): {
  n: number;
  title: string;
  /** Distinct section links for this source, in citation order. */
  urls: string[];
  collectionName?: string;
}[] {
  const byNumber = new Map<number, { first: AskCitation; urls: string[] }>();
  for (const block of turn.blocks) {
    for (const citation of block.citations) {
      const entry = byNumber.get(citation.n);
      if (!entry) {
        byNumber.set(citation.n, { first: citation, urls: [citation.url] });
      } else if (!entry.urls.includes(citation.url)) {
        entry.urls.push(citation.url);
      }
    }
  }
  return [...byNumber.values()]
    .sort((a, b) => a.first.n - b.first.n)
    .map(({ first, urls }) => ({
      n: first.n,
      title: first.title,
      urls,
      collectionName: turn.sources?.find((s) => s.n === first.n)
        ?.collectionName,
    }));
}

const BLOCK_KINDS = [
  "paragraph",
  "heading",
  "listItem",
  "tableHeader",
  "tableRow",
  "code",
];
const FAILURES = [
  "no_answer",
  "unverified",
  "budget",
  "quota",
  "unavailable",
  "timeout",
  "cancelled",
  "error",
];
const PHASE_ORDER = ["searching", "generating"];

function validCitation(c: AskCitation): boolean {
  return (
    !!c &&
    typeof c.n === "number" &&
    typeof c.title === "string" &&
    typeof c.url === "string"
  );
}

function validSource(source: AskSource): boolean {
  return (
    !!source &&
    typeof source.n === "number" &&
    typeof source.title === "string" &&
    typeof source.url === "string"
  );
}

/**
 * Turns the stream of events into the view model of the page. Events for a
 * turn that is no longer active are ignored.
 *
 * @param state the current state.
 * @param action what happened.
 * @returns the next state.
 */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === "reset") {
    return initialChatState;
  }
  if (action.type === "submit") {
    const id = (state.turns[state.turns.length - 1]?.id ?? 0) + 1;
    return {
      ...state,
      turns: [
        ...state.turns,
        {
          id,
          question: action.question,
          scope: action.scope,
          status: "searching",
          sources: null,
          blocks: [],
        },
      ],
    };
  }

  if (
    action.type === "feedbackStart" ||
    action.type === "feedbackDone" ||
    action.type === "feedbackFailed"
  ) {
    return reduceFeedback(state, action);
  }

  const turn = state.turns[state.turns.length - 1];
  if (!turn || !isActive(turn)) {
    return state;
  }
  const update = (
    patch: Partial<Turn>,
    conversationId = state.conversationId
  ): ChatState => ({
    conversationId,
    turns: [...state.turns.slice(0, -1), { ...turn, ...patch }],
  });

  switch (action.type) {
    case "requestFailed":
      return update({
        status: "failed",
        problem: action.problem,
        retryAfter: action.retryAfter,
      });
    case "stopped":
      return update({ status: "stopped" });
    case "ended":
      // The stream closed without done or failed.
      return update({ status: "failed", problem: "error" });
    case "event": {
      const { event } = action;
      // The payload is trusted JSON from the network; ignore anything off-shape.
      if (!event || !event.data) {
        return state;
      }
      switch (event.event) {
        case "conversation":
          return typeof event.data.id === "string"
            ? update({}, event.data.id)
            : state;
        case "status": {
          const { phase, notice } = event.data;
          if (phase === "notice") {
            // Only the stable code is kept; the server's English message is not shown.
            return update({
              notice: typeof notice === "string" && notice ? notice : "unknown",
            });
          }
          // Phases only move forward: a late "searching" after blocks is noise.
          if (
            PHASE_ORDER.indexOf(phase) < 0 ||
            PHASE_ORDER.indexOf(phase) < PHASE_ORDER.indexOf(turn.status) ||
            (phase === "searching" && turn.blocks.length > 0)
          ) {
            return state;
          }
          return update({ status: phase });
        }
        case "sources":
          return Array.isArray(event.data)
            ? update({ sources: event.data.filter(validSource) })
            : state;
        case "block": {
          const { index, kind, markdown, citations } = event.data;
          if (
            typeof index !== "number" ||
            !BLOCK_KINDS.includes(kind) ||
            typeof markdown !== "string" ||
            !Array.isArray(citations) ||
            turn.blocks.some((b) => b.index === index)
          ) {
            return state;
          }
          return update({
            status: "generating",
            blocks: [
              ...turn.blocks,
              {
                index,
                kind,
                markdown,
                citations: citations.filter(validCitation),
              },
            ],
          });
        }
        case "done":
          return update(
            {
              status: "done",
              usageId:
                typeof event.data.usageId === "string" &&
                isUUID(event.data.usageId)
                  ? event.data.usageId
                  : null,
            },
            typeof event.data.conversationId === "string"
              ? event.data.conversationId
              : null
          );
        case "failed":
          return update({
            status: "failed",
            problem: FAILURES.includes(event.data.reason)
              ? event.data.reason
              : "error",
          });
        default:
          return state;
      }
    }
    default:
      return state;
  }
}

/**
 * Whether feedback can be given for a turn: finished normally and recorded.
 *
 * @param turn the turn.
 * @returns true when the helpful / not helpful buttons apply.
 */
export function canRate(turn: Turn): boolean {
  return turn.status === "done" && !!turn.usageId && !turn.feedback?.hidden;
}

function reduceFeedback(
  state: ChatState,
  action: Extract<
    ChatAction,
    { type: "feedbackStart" | "feedbackDone" | "feedbackFailed" }
  >
): ChatState {
  const index = state.turns.findIndex((t) => t.id === action.turnId);
  const turn = state.turns[index];
  if (!turn || !canRate(turn)) {
    return state;
  }
  const current: Feedback = turn.feedback ?? {
    rating: null,
    previous: null,
    pending: false,
  };
  let next: Feedback;
  switch (action.type) {
    case "feedbackStart":
      if (current.pending) {
        return state;
      }
      next = {
        rating: action.rating,
        previous: current.rating,
        pending: true,
      };
      break;
    case "feedbackDone":
      next = { ...current, pending: false, saved: true };
      break;
    default:
      next =
        action.error === "refused"
          ? {
              ...current,
              rating: current.previous,
              pending: false,
              hidden: true,
            }
          : {
              ...current,
              rating: current.previous,
              pending: false,
              error: action.error,
            };
  }
  return {
    ...state,
    turns: state.turns.map((t, i) =>
      i === index ? { ...t, feedback: next } : t
    ),
  };
}
