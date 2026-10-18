import { isUUID } from "validator";
import type {
  AskCitation,
  AskEvent,
  AskFailure,
  AskSource,
} from "~/utils/streamFetch";
import type { StoredTurn } from "~/models/AIConversation";
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
  /** Indexes of stored blocks withheld because a cited source changed or is no longer readable. */
  hiddenBlocks?: number[];
  problem?: TurnProblem;
  /** Id of the metered usage row, needed to send feedback; null if not recorded. */
  usageId?: string | null;
  /** Helpful / not helpful state of a finished answer. */
  feedback?: Feedback;
  /** Seconds the server asked us to wait after a 429. */
  retryAfter?: number;
  /**
   * The conversation id before this turn's `conversation` event. An id is
   * only kept once `done` or `failed` confirms the turn was stored; a turn cut
   * short (stopped, dropped) stores nothing, so the id is rolled back.
   */
  conversationIdBefore?: string | null;
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
  | { type: "hydrate"; conversationId: string; turns: StoredTurn[] }
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

/** One cited passage location within a source. */
export interface CitedSection {
  /** Section link, with the heading anchor. */
  url: string;
  /** The cited passage, untrusted text. */
  quote?: string;
}

export interface CitedSource {
  n: number;
  title: string;
  /** Distinct sections of this source, in citation order. */
  sections: CitedSection[];
  collectionName?: string;
}

/**
 * Collects the sources cited by an answer, in citation order, preferring the
 * retrieved source's collection name and the first citation's section link.
 *
 * @param turn the turn.
 * @returns one entry per cited source number.
 */
export function citedSources(turn: Turn): CitedSource[] {
  const byNumber = new Map<
    number,
    { first: AskCitation; sections: CitedSection[] }
  >();
  for (const block of turn.blocks) {
    for (const citation of block.citations) {
      const entry = byNumber.get(citation.n);
      const quote = citation.quote?.trim() || undefined;
      if (!entry) {
        byNumber.set(citation.n, {
          first: citation,
          sections: [{ url: citation.url, quote }],
        });
        continue;
      }
      const section = entry.sections.find((x) => x.url === citation.url);
      if (!section) {
        entry.sections.push({ url: citation.url, quote });
      } else if (!section.quote && quote) {
        section.quote = quote;
      }
    }
  }
  return [...byNumber.values()]
    .sort((a, b) => a.first.n - b.first.n)
    .map(({ first, sections }) => ({
      n: first.n,
      title: first.title,
      sections,
      collectionName: turn.sources?.find((s) => s.n === first.n)
        ?.collectionName,
    }));
}

/**
 * A readable label for a section link, derived from its `#h-some-heading`
 * anchor. Text only; returns undefined when there is no usable heading.
 *
 * @param url a source or citation path.
 * @returns the heading text, or undefined.
 */
export function sectionLabel(url: string): string | undefined {
  const hash = url.split("#")[1];
  if (!hash?.startsWith("h-")) {
    return undefined;
  }
  let raw = hash.slice(2);
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // keep the undecoded fragment
  }
  const label = raw
    .replace(/[-_+]+/g, " ")
    .trim()
    .slice(0, 80);
  return label || undefined;
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
function isBlockKind(kind: string): kind is BlockInput["kind"] {
  return BLOCK_KINDS.includes(kind);
}

function isFailure(reason: string): reason is AskFailure {
  return FAILURES.includes(reason);
}

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
  if (action.type === "hydrate") {
    return {
      conversationId: action.conversationId,
      turns: Array.isArray(action.turns)
        ? action.turns.map(hydrateTurn).filter((t) => !!t)
        : [],
    };
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
  // A turn that ends without done/failed was not stored under a new id.
  const unconfirmedId =
    turn.conversationIdBefore === undefined
      ? state.conversationId
      : turn.conversationIdBefore;
  const update = (
    patch: Partial<Turn>,
    conversationId = state.conversationId
  ): ChatState => ({
    conversationId,
    turns: [...state.turns.slice(0, -1), { ...turn, ...patch }],
  });

  switch (action.type) {
    case "requestFailed":
      return update(
        {
          status: "failed",
          problem: action.problem,
          retryAfter: action.retryAfter,
        },
        unconfirmedId
      );
    case "stopped":
      return update({ status: "stopped" }, unconfirmedId);
    case "ended":
      // The stream closed without done or failed.
      return update({ status: "failed", problem: "error" }, unconfirmedId);
    case "event": {
      const { event } = action;
      // The payload is trusted JSON from the network; ignore anything off-shape.
      if (!event || !event.data) {
        return state;
      }
      switch (event.event) {
        case "conversation":
          return typeof event.data.id === "string"
            ? update(
                event.data.id === state.conversationId
                  ? {}
                  : { conversationIdBefore: state.conversationId },
                event.data.id
              )
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

/** A run of visible blocks, or a withheld part of a stored answer. */
export type AnswerSegment =
  | { type: "blocks"; blocks: Turn["blocks"] }
  | { type: "hidden" };

/**
 * Splits an answer into runs of visible blocks with one `hidden` segment
 * wherever stored blocks were withheld, keeping their original positions.
 *
 * @param turn the turn.
 * @returns the segments in reading order.
 */
export function answerSegments(turn: Turn): AnswerSegment[] {
  if (!turn.hiddenBlocks?.length) {
    return turn.blocks.length ? [{ type: "blocks", blocks: turn.blocks }] : [];
  }
  const entries = [
    ...turn.blocks.map((block) => ({ index: block.index, block })),
    ...turn.hiddenBlocks.map((index) => ({ index, block: undefined })),
  ].sort((a, b) => a.index - b.index);
  const segments: AnswerSegment[] = [];
  for (const { block } of entries) {
    const last = segments[segments.length - 1];
    if (!block) {
      if (last?.type !== "hidden") {
        segments.push({ type: "hidden" });
      }
    } else if (last?.type === "blocks") {
      last.blocks.push(block);
    } else {
      segments.push({ type: "blocks", blocks: [block] });
    }
  }
  return segments;
}

/**
 * Maps one stored turn from `aiConversations.info` to the view model. The
 * payload is server JSON: anything off-shape is dropped, hidden blocks keep
 * only their position, and citation titles come from the fresh sources.
 */
function hydrateTurn(stored: StoredTurn, i: number): Turn | undefined {
  if (!stored || typeof stored.question !== "string") {
    return undefined;
  }
  const sources = (Array.isArray(stored.sources) ? stored.sources : []).filter(
    validSource
  );
  const blocks: Turn["blocks"] = [];
  const hiddenBlocks: number[] = [];
  (Array.isArray(stored.blocks) ? stored.blocks : []).forEach((b, index) => {
    if (!b || !isBlockKind(b.kind)) {
      return;
    }
    if (b.hidden === true) {
      hiddenBlocks.push(index);
      return;
    }
    if (typeof b.markdown !== "string" || !Array.isArray(b.citations)) {
      return;
    }
    blocks.push({
      index,
      kind: b.kind,
      markdown: b.markdown,
      citations: b.citations.filter(validCitation).map((c) => ({
        ...c,
        title: sources.find((s) => s.n === c.n)?.title ?? c.title,
      })),
    });
  });
  const answered = stored.outcome === "answered";
  return {
    id: i + 1,
    question: stored.question,
    scope: {},
    status: answered ? "done" : "failed",
    sources,
    blocks,
    ...(hiddenBlocks.length ? { hiddenBlocks } : {}),
    ...(answered
      ? {}
      : {
          problem: isFailure(stored.outcome) ? stored.outcome : "error",
        }),
    usageId:
      typeof stored.usageId === "string" && isUUID(stored.usageId)
        ? stored.usageId
        : null,
  };
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
