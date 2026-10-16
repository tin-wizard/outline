import { randomUUID } from "node:crypto";
import isUUID from "validator/lib/isUUID";
import Logger from "@server/logging/Logger";
import { Document } from "@server/models";
import type { User } from "@server/models";
import { can } from "@server/policies";
import Redis from "@server/storage/redis";
import { blockToMarkdown } from "./blocks";
import { redactSecrets } from "./redact";
import { dropAIExcluded } from "./retrieve";
import type { AcceptedBlock } from "./verify";

/** One question and its verified answer, written by the server only. */
export interface ConversationTurn {
  question: string;
  /** Verified, redacted Markdown; null when no answer was kept. */
  answer: string | null;
  citedDocumentIds: string[];
  /** Epoch milliseconds. */
  at: number;
}

/** A user's AI conversation; the client only ever holds its id. */
export interface Conversation {
  id: string;
  teamId: string;
  userId: string;
  turns: ConversationTurn[];
}

/** The result of loading a conversation. */
export interface LoadResult {
  /** Null for unknown, expired, foreign or unreadable conversations. */
  conversation: Conversation | null;
  /** True when Redis failed, so the turn runs without history. */
  unavailable: boolean;
}

/** What 2.1 hands over to store a turn: never free-form model text. */
export interface TurnInput {
  /** The user's original question; redacted and truncated before storing. */
  question: string;
  /** The verifier's released blocks (`AnswerVerifier.released`); [] to abstain. */
  released: AcceptedBlock[];
  /** Epoch milliseconds; defaults to now. */
  at?: number;
}

/** A prior turn as it may be shown to the model. */
export interface HistoryTurn {
  question: string;
  /** Null when any document the answer cited is no longer readable. */
  answer: string | null;
}

/** Idle time after which a conversation expires; refreshed on read and append. */
export const CONVERSATION_TTL_SECONDS = 3600;

/** Turns kept per conversation; the oldest is dropped first. */
export const MAX_TURNS = 8;

/** Estimated tokens (characters / 3) of stored history. */
export const HISTORY_TOKEN_BUDGET = 6000;

/**
 * Starts a new, empty conversation for the user.
 *
 * @param user the user.
 * @returns the conversation, or null when Redis is unavailable.
 */
export async function createConversation(
  user: User
): Promise<Conversation | null> {
  const conversation: Conversation = {
    id: randomUUID(),
    teamId: user.teamId,
    userId: user.id,
    turns: [],
  };
  try {
    await withTimeout(
      Redis.defaultClient.set(
        conversationKey(user, conversation.id),
        JSON.stringify(conversation),
        "EX",
        CONVERSATION_TTL_SECONDS
      )
    );
    return conversation;
  } catch {
    Logger.warn("AI answers could not create a conversation");
    return null;
  }
}

/**
 * Loads one of the user's conversations and refreshes its expiry.
 *
 * @param user the user.
 * @param id the conversation id supplied by the client.
 * @returns the conversation, or null with `unavailable` set when Redis failed.
 */
export async function loadConversation(
  user: User,
  id: string
): Promise<LoadResult> {
  if (!isUUID(id)) {
    return { conversation: null, unavailable: false };
  }
  try {
    return {
      conversation: parseConversation(user, id, await readAndTouch(user, id)),
      unavailable: false,
    };
  } catch {
    Logger.warn("AI answers could not load a conversation; no history used");
    return { conversation: null, unavailable: true };
  }
}

/**
 * Adds a turn to one of the user's conversations, keeping the turn cap and
 * the history budget, and refreshes its expiry.
 *
 * The answer and cited ids are derived here from the verifier's released
 * blocks, so only verified text can re-enter a later model context.
 *
 * @param user the user.
 * @param id the conversation id.
 * @param input the question and the released blocks of the answer.
 * @returns true when stored; false for an unknown or deleted conversation or a Redis failure.
 */
export async function appendTurn(
  user: User,
  id: string,
  input: TurnInput
): Promise<boolean> {
  if (!isUUID(id)) {
    return false;
  }
  try {
    const conversation = parseConversation(
      user,
      id,
      await readAndTouch(user, id)
    );
    if (!conversation) {
      return false;
    }
    // shortcut: read-modify-write, so two turns appended at the same moment
    // can lose one; the UI sends one turn at a time. Use a Lua script if not.
    conversation.turns = trimToBudget([...conversation.turns, toTurn(input)]);
    // XX: a conversation deleted since it was read stays deleted.
    const stored = await withTimeout(
      Redis.defaultClient.set(
        conversationKey(user, id),
        JSON.stringify(conversation),
        "EX",
        CONVERSATION_TTL_SECONDS,
        "XX"
      )
    );
    return stored === "OK";
  } catch {
    Logger.warn("AI answers could not save a conversation turn");
    return false;
  }
}

/**
 * Deletes one of the user's conversations.
 *
 * @param user the user.
 * @param id the conversation id.
 * @returns true when a conversation was deleted.
 */
export async function deleteConversation(
  user: User,
  id: string
): Promise<boolean> {
  if (!isUUID(id)) {
    return false;
  }
  try {
    return (
      (await withTimeout(Redis.defaultClient.del(conversationKey(user, id)))) >
      0
    );
  } catch {
    Logger.warn("AI answers could not delete a conversation");
    return false;
  }
}

/**
 * Builds the retrieval query for a follow-up without a model call: the new
 * question, the previous question and the titles of the documents the previous
 * answer cited that the user can still read now. Secrets are redacted.
 *
 * @param user the user asking.
 * @param conversation the user's conversation, as loaded from the store.
 * @param question the new question.
 * @returns the standalone query.
 */
export async function buildStandaloneQuery(
  user: User,
  conversation: Conversation | null,
  question: string
): Promise<string> {
  const previous = ownTurns(user, conversation).at(-1);
  if (!previous) {
    return redactSecrets(question).text;
  }
  const readable = await readableDocuments(user, previous.citedDocumentIds);
  const titles = [
    ...new Set(
      previous.citedDocumentIds
        .map((id) => readable.get(id)?.title.trim())
        .filter((title): title is string => !!title)
    ),
  ].slice(0, MAX_QUERY_TITLES);
  return redactSecrets([question, previous.question, ...titles].join(" ")).text;
}

/**
 * The prior turns of a conversation for the model's context. An answer is kept
 * only when every document it cited is still readable by the user now and not
 * excluded from AI answers; otherwise only its question is kept.
 *
 * @param user the user asking.
 * @param conversation the user's conversation, as loaded from the store.
 * @returns the prior turns, oldest first, questions redacted.
 */
export async function historyForModel(
  user: User,
  conversation: Conversation | null
): Promise<HistoryTurn[]> {
  const turns = ownTurns(user, conversation);
  const readable = await readableDocuments(
    user,
    turns.flatMap((t) => t.citedDocumentIds)
  );
  return turns.map((t) => ({
    question: redactSecrets(t.question).text,
    // An answer without citations has no verified claims to carry forward.
    answer:
      t.answer !== null &&
      t.citedDocumentIds.length > 0 &&
      t.citedDocumentIds.every((id) => readable.has(id))
        ? t.answer
        : null,
  }));
}

const REDIS_TIMEOUT_MS = 2000;
const MAX_QUERY_TITLES = 3;
const MAX_QUESTION_CHARS = 500;
// Below the budget with a full question, so the newest answer always fits.
const MAX_ANSWER_CHARS = 17_000;
const MAX_CITED_DOCUMENTS = 20;

/**
 * Builds the stored turn from verified blocks. An answer that is too long or
 * cites too many documents to re-check is dropped rather than cut.
 */
function toTurn(input: TurnInput): ConversationTurn {
  const question = [...redactSecrets(input.question).text]
    .slice(0, MAX_QUESTION_CHARS)
    .join("");
  const answer = input.released
    .map(
      (r, i) =>
        // Table rows join their header with a single newline.
        (i === 0 ? "" : r.block.kind === "tableRow" ? "\n" : "\n\n") +
        blockToMarkdown(r.block)
    )
    .join("");
  const citedDocumentIds = [
    ...new Set(
      input.released.flatMap((r) => r.citations.map((c) => c.documentId))
    ),
  ];
  const keep =
    answer.trim() !== "" &&
    answer.length <= MAX_ANSWER_CHARS &&
    citedDocumentIds.length <= MAX_CITED_DOCUMENTS;
  return {
    question,
    answer: keep ? answer : null,
    citedDocumentIds: keep ? citedDocumentIds : [],
    at: input.at ?? Date.now(),
  };
}

function conversationKey(user: User, id: string): string {
  return `aiconv:${user.teamId}:${user.id}:${id}`;
}

async function readAndTouch(user: User, id: string): Promise<string | null> {
  const key = conversationKey(user, id);
  const results = await withTimeout(
    Redis.defaultClient
      .multi()
      .get(key)
      .expire(key, CONVERSATION_TTL_SECONDS)
      .exec()
  );
  const [error, value] = results?.[0] ?? [new Error("no result"), null];
  if (error) {
    throw error;
  }
  return typeof value === "string" ? value : null;
}

/** Parses a stored conversation, rejecting anything not owned by the user. */
function parseConversation(
  user: User,
  id: string,
  raw: string | null
): Conversation | null {
  if (!raw) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.id !== id ||
    value.teamId !== user.teamId ||
    value.userId !== user.id ||
    !Array.isArray(value.turns) ||
    !value.turns.every(isTurn)
  ) {
    return null;
  }
  return { id, teamId: user.teamId, userId: user.id, turns: value.turns };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTurn(value: unknown): value is ConversationTurn {
  return (
    isRecord(value) &&
    typeof value.question === "string" &&
    (value.answer === null || typeof value.answer === "string") &&
    Array.isArray(value.citedDocumentIds) &&
    value.citedDocumentIds.every((id) => typeof id === "string") &&
    typeof value.at === "number"
  );
}

/** Turns of a conversation only when it belongs to the user. */
function ownTurns(
  user: User,
  conversation: Conversation | null
): ConversationTurn[] {
  if (
    !conversation ||
    conversation.teamId !== user.teamId ||
    conversation.userId !== user.id
  ) {
    return [];
  }
  return conversation.turns;
}

/**
 * Applies the turn cap, then the token budget: older answers are dropped
 * first, then older turns, and the newest answer only as a last resort; the
 * newest question is always kept.
 */
function trimToBudget(turns: ConversationTurn[]): ConversationTurn[] {
  const result = turns.slice(-MAX_TURNS).map((t) => ({ ...t }));
  const tokens = () =>
    Math.ceil(
      result.reduce(
        (sum, t) => sum + t.question.length + (t.answer?.length ?? 0),
        0
      ) / 3
    );
  for (const t of result.slice(0, -1)) {
    if (tokens() <= HISTORY_TOKEN_BUDGET) {
      return result;
    }
    t.answer = null;
  }
  while (result.length > 1 && tokens() > HISTORY_TOKEN_BUDGET) {
    result.shift();
  }
  if (tokens() > HISTORY_TOKEN_BUDGET) {
    result[0].answer = null;
    result[0].citedDocumentIds = [];
  }
  return result;
}

/**
 * The documents among `ids` that the user may read now, matching what search
 * returns: not deleted, allowed by the document read policy, not a template,
 * published (or the user's own draft) and not in a collection excluded from AI.
 * Fails closed: any error means nothing is readable.
 */
async function readableDocuments(
  user: User,
  ids: string[]
): Promise<Map<string, Document>> {
  const unique = [...new Set(ids)].filter((id) => isUUID(id));
  if (unique.length === 0) {
    return new Map();
  }
  try {
    const found = await Document.findByIds(unique, {
      userId: user.id,
      includeViews: false,
    });
    const allowed = await dropAIExcluded(
      user,
      found.filter(
        (d) =>
          can(user, "read", d) &&
          !d.template &&
          (!!d.publishedAt || d.createdById === user.id)
      )
    );
    return new Map(allowed.map((d) => [d.id, d]));
  } catch {
    Logger.warn("AI answers could not re-authorize cited documents");
    return new Map();
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Redis timeout")),
      REDIS_TIMEOUT_MS
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
