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
  /** A fixed server notice, such as a lost conversation. */
  notice?: string;
  /** Retrieved sources; null until the `sources` event. */
  sources: AskSource[] | null;
  blocks: (BlockInput & { index: number })[];
  problem?: TurnProblem;
}

export interface ChatState {
  /** Sent with follow-ups; null for the first question or an unstored turn. */
  conversationId: string | null;
  turns: Turn[];
}

export type ChatAction =
  | { type: "submit"; question: string; scope: Scope }
  | { type: "event"; event: AskEvent }
  | { type: "requestFailed"; problem: TurnProblem }
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
  url: string;
  collectionName?: string;
}[] {
  const byNumber = new Map<number, AskCitation>();
  for (const block of turn.blocks) {
    for (const citation of block.citations) {
      if (!byNumber.has(citation.n)) {
        byNumber.set(citation.n, citation);
      }
    }
  }
  return [...byNumber.values()]
    .sort((a, b) => a.n - b.n)
    .map((c) => ({
      n: c.n,
      title: c.title,
      url: c.url,
      collectionName: turn.sources?.find((s) => s.n === c.n)?.collectionName,
    }));
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
      return update({ status: "failed", problem: action.problem });
    case "stopped":
      return update({ status: "stopped" });
    case "ended":
      // The stream closed without done or failed.
      return update({ status: "failed", problem: "error" });
    case "event": {
      const { event } = action;
      switch (event.event) {
        case "conversation":
          return update({}, event.data.id);
        case "status":
          if (event.data.phase === "notice") {
            return update({ notice: event.data.message });
          }
          return update({ status: event.data.phase });
        case "sources":
          return update({ sources: event.data });
        case "block":
          if (turn.blocks.some((b) => b.index === event.data.index)) {
            return state;
          }
          return update({
            status: "generating",
            blocks: [...turn.blocks, event.data],
          });
        case "done":
          return update({ status: "done" }, event.data.conversationId);
        case "failed":
          return update({ status: "failed", problem: event.data.reason });
        default:
          return state;
      }
    }
    default:
      return state;
  }
}
