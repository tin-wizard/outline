import { isUUID } from "validator";
import type {
  AskCitation,
  AskEvent,
  AskFailure,
  AskRetrieval,
  AskSource,
} from "~/utils/streamFetch";
import type { StoredScope, StoredTurn } from "~/models/AIConversation";
import type { BlockInput } from "./markdown";

/** Why a turn did not produce a complete answer. */
export type TurnProblem =
  | AskFailure
  | "unauthorized"
  | "forbidden"
  | "rateLimited"
  | "network"
  | "compare_disabled";

export type TurnStatus =
  | "searching"
  | "generating"
  | "done"
  | "failed"
  | "stopped";

export type Rating = "up" | "down";

/** Why an answer is reported inaccurate; mirrors the `ai.feedback` enum. */
export const REPORT_REASONS = [
  "inaccurate",
  "incomplete",
  "outdated",
  "off_topic",
  "other",
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

/** The longest report comment the server accepts. */
export const MAX_REPORT_COMMENT = 500;

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

/** The time windows offered by the date chip; `custom` uses `dateFrom`/`dateTo`. */
export type DatePreset = "week" | "month" | "year" | "custom";

/** A document picked as the scope; the title is only for display. */
export interface ScopeDocument {
  id: string;
  title: string;
}

/**
 * What a question is limited to. Collections and specific documents are
 * mutually exclusive in the UI (see scope.ts): picking one clears the other.
 */
export interface Scope {
  collectionIds?: string[];
  documents?: ScopeDocument[];
  datePreset?: DatePreset;
  /** YYYY-MM-DD, UTC, inclusive. */
  dateFrom?: string;
  dateTo?: string;
  mode?: "answer" | "compare";
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
  /** Blocks the verifier left out of the answer; absent means 0. */
  droppedSegments?: number;
  problem?: TurnProblem;
  /** Id of the metered usage row, needed to send feedback; null if not recorded. */
  usageId?: string | null;
  /** Helpful / not helpful state of a finished answer. */
  feedback?: Feedback;
  /** Seconds the server asked us to wait after a 429. */
  retryAfter?: number;
  /** ISO time a budget or quota limit resets, when the server said. */
  resetsAt?: string;
  /** Server-measured duration of the answer; absent on older turns. */
  timings?: { totalMs: number };
  /** Candidates fetched (capped) and documents used; absent on older turns. */
  retrieval?: AskRetrieval;
  /** The scope of a resumed turn, as stored; names only while still visible. */
  storedScope?: StoredScope;
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
  /** The section's heading text from the server, untrusted plain text. */
  heading?: string;
}

export interface CitedSource {
  n: number;
  title: string;
  /** Distinct sections of this source, in citation order. */
  sections: CitedSection[];
  collectionName?: string;
  collectionColor?: string;
  /** ISO time of the last edit, when the server sent it. */
  updatedAt?: string;
  updatedByName?: string;
  /** In how many blocks of the answer this source is cited. */
  count: number;
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
    { first: AskCitation; sections: CitedSection[]; count: number }
  >();
  for (const block of turn.blocks) {
    for (const n of new Set(block.citations.map((c) => c.n))) {
      const counted = byNumber.get(n);
      if (counted) {
        counted.count += 1;
      }
    }
    for (const citation of block.citations) {
      const entry = byNumber.get(citation.n);
      const quote = citation.quote?.trim() || undefined;
      const { heading } = citation;
      if (!entry) {
        byNumber.set(citation.n, {
          first: citation,
          sections: [{ url: citation.url, quote, heading }],
          count: 1,
        });
        continue;
      }
      const section = entry.sections.find((x) => x.url === citation.url);
      if (!section) {
        entry.sections.push({ url: citation.url, quote, heading });
      } else {
        section.quote ||= quote;
        section.heading ||= heading;
      }
    }
  }
  return [...byNumber.values()]
    .sort((a, b) => a.first.n - b.first.n)
    .map(({ first, sections, count }) => {
      const source = turn.sources?.find((s) => s.n === first.n);
      return {
        n: first.n,
        title: first.title,
        sections,
        count,
        collectionName: source?.collectionName,
        collectionColor: source?.collectionColor,
        updatedAt: source?.updatedAt,
        updatedByName: source?.updatedByName,
      };
    });
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

/**
 * The label of a cited section: the server's heading text, or, when it sent
 * none, one derived from the link's anchor.
 *
 * @param section the cited section.
 * @returns the label, or undefined when there is no usable heading.
 */
export function sectionHeading(section: CitedSection): string | undefined {
  return section.heading ?? sectionLabel(section.url);
}

const MAX_HEADING_LENGTH = 120;

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
  "scope_forbidden",
  "compare_needs_two",
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

/** Keeps the heading only if it is non-empty plain text of sane length. */
function cleanCitation(c: AskCitation): AskCitation {
  const { heading, ...rest } = c;
  const text = typeof heading === "string" ? heading.trim() : "";
  // \p{C} covers control characters, including line breaks.
  return text && text.length <= MAX_HEADING_LENGTH && !/\p{C}/u.test(text)
    ? { ...rest, heading: text }
    : rest;
}

/** A non-negative integer count, otherwise 0. */
function cleanCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : 0;
}

function validSource(source: AskSource): boolean {
  return (
    !!source &&
    typeof source.n === "number" &&
    typeof source.title === "string" &&
    typeof source.url === "string"
  );
}

const MAX_NAME_LENGTH = 200;
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function cleanName(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= MAX_NAME_LENGTH ? text : undefined;
}

function cleanDate(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

/**
 * Keeps the details of a source that are well-formed and drops the rest, so a
 * bad value (an odd colour, a junk date) never reaches the UI.
 */
function cleanSource(source: AskSource): AskSource {
  const collectionId =
    typeof source.collectionId === "string" && isUUID(source.collectionId)
      ? source.collectionId
      : undefined;
  const collectionColor =
    typeof source.collectionColor === "string" &&
    HEX_COLOR.test(source.collectionColor)
      ? source.collectionColor
      : undefined;
  return {
    n: source.n,
    documentId: source.documentId,
    title: source.title,
    url: source.url,
    ...(collectionId ? { collectionId } : {}),
    ...(cleanName(source.collectionName)
      ? { collectionName: cleanName(source.collectionName) }
      : {}),
    ...(collectionColor ? { collectionColor } : {}),
    ...(cleanDate(source.updatedAt)
      ? { updatedAt: cleanDate(source.updatedAt) }
      : {}),
    ...(cleanName(source.updatedByName)
      ? { updatedByName: cleanName(source.updatedByName) }
      : {}),
    ...(cleanDate(source.publishedAt)
      ? { publishedAt: cleanDate(source.publishedAt) }
      : {}),
  };
}

function cleanTimings(value: unknown): Turn["timings"] {
  const totalMs =
    value && typeof value === "object" && "totalMs" in value
      ? value.totalMs
      : undefined;
  return typeof totalMs === "number" && Number.isFinite(totalMs) && totalMs >= 0
    ? { totalMs }
    : undefined;
}

function cleanRetrieval(value: unknown): AskRetrieval | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const fetched = "fetched" in value ? value.fetched : undefined;
  const used = "used" in value ? value.used : undefined;
  return typeof fetched === "number" &&
    typeof used === "number" &&
    Number.isInteger(fetched) &&
    Number.isInteger(used) &&
    fetched >= 0 &&
    used >= 0
    ? { fetched, used }
    : undefined;
}

function cleanScope(value: StoredScope | undefined): StoredScope | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const collections = (
    Array.isArray(value.collections) ? value.collections : []
  ).flatMap((c) =>
    c && typeof c.id === "string" && isUUID(c.id)
      ? [{ id: c.id, name: cleanName(c.name) }]
      : []
  );
  const documents = (
    Array.isArray(value.documents) ? value.documents : []
  ).flatMap((d) =>
    d && typeof d.id === "string" && isUUID(d.id)
      ? [{ id: d.id, title: cleanName(d.title) }]
      : []
  );
  const dateFrom = cleanDate(value.dateFrom);
  const dateTo = cleanDate(value.dateTo);
  return collections.length || documents.length || dateFrom || dateTo
    ? { collections, documents, dateFrom, dateTo }
    : undefined;
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
            ? update({
                sources: event.data.filter(validSource).map(cleanSource),
              })
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
                citations: citations.filter(validCitation).map(cleanCitation),
              },
            ],
          });
        }
        case "done":
          return update(
            {
              status: "done",
              droppedSegments: cleanCount(event.data.dropped),
              timings: cleanTimings(event.data.timings),
              retrieval: cleanRetrieval(event.data.retrieval),
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
            resetsAt: cleanDate(event.data.detail?.resetsAt),
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
  const sources = (Array.isArray(stored.sources) ? stored.sources : [])
    .filter(validSource)
    .map(cleanSource);
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
        ...cleanCitation(c),
        title: sources.find((s) => s.n === c.n)?.title ?? c.title,
      })),
    });
  });
  const answered = stored.outcome === "answered";
  return {
    id: i + 1,
    question: stored.question,
    scope: stored.mode === "compare" ? { mode: "compare" } : {},
    status: answered ? "done" : "failed",
    sources,
    blocks,
    ...(hiddenBlocks.length ? { hiddenBlocks } : {}),
    droppedSegments: cleanCount(stored.droppedSegments),
    timings: cleanTimings(stored.timings),
    retrieval: cleanRetrieval(stored.retrieval),
    storedScope: cleanScope(stored.scope),
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
