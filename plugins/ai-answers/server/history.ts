import isUUID from "validator/lib/isUUID";
import Logger from "@server/logging/Logger";
import { AIConversation, AIConversationTurn, Document } from "@server/models";
import type { User } from "@server/models";
import type {
  StoredBlock,
  StoredCitation,
  StoredScope,
} from "@server/models/AIConversationTurn";
import { sequelize } from "@server/storage/database";
import { isHistoryEnabled } from "./access";
import { safeCitationTarget } from "./anchors";
import type { AskCitation, AskRetrieval, AskSource } from "./api/ask";
import { blockToMarkdown } from "./blocks";
import {
  MAX_ANSWER_CHARS,
  MAX_CITED_DOCUMENTS,
  MAX_QUESTION_CHARS,
  MAX_TURNS,
  joinBlockMarkdown,
  readableDocuments,
  type Conversation,
} from "./conversation";
import env from "./env";
import {
  accessibleCollections,
  presentSourceDetails,
} from "./presenters/source";
import { redactSecrets } from "./redact";
import { MAX_SCOPE_COLLECTIONS, MAX_SCOPE_DOCUMENTS } from "./retrieve";
import type { AcceptedBlock } from "./verify";

/** Days a conversation is kept after its last activity, unless configured. */
export const DEFAULT_RETENTION_DAYS = 90;

/** Most turns a stored conversation may hold. */
export const MAX_STORED_TURNS = 100;

/** Longest conversation title, in characters. */
export const MAX_TITLE_CHARS = 80;

/** Largest value of a smallint column. */
const MAX_SMALLINT = 32_767;

/** Largest value of an integer column. */
const MAX_INTEGER = 2_147_483_647;

/** A whole number clamped to [0, max]; null when not a finite number. */
const clampCount = (value: number | undefined, max: number) =>
  value === undefined || !Number.isFinite(value)
    ? null
    : Math.min(Math.max(Math.trunc(value), 0), max);

/** What `ai.ask` hands over to store a turn: never free-form model text. */
export interface StoreTurnInput {
  /** The conversation to continue; a new one is created when omitted. */
  conversationId?: string | null;
  /**
   * True when `ai.ask` may create the row with `conversationId` if it is
   * missing: it minted the id in this request, or the user's own hot cache
   * key for it is live. Otherwise only an existing row is continued, so a
   * deleted conversation is never recreated by a late turn.
   */
  create?: boolean;
  /** Text to title a new conversation with (redacted here); defaults to the question. */
  title?: string;
  /** Blocks the verifier dropped from this answer. */
  droppedSegments?: number;
  /** The user's original question; redacted and truncated before storing. */
  question: string;
  /** The verifier's released blocks (`AnswerVerifier.released`); [] when failed. */
  released: AcceptedBlock[];
  /** "answered", or the `ai.ask` failure reason. */
  outcome: string;
  /** The metered usage row of the answer, if any. */
  usageId: string | null;
  /** The scope the question was asked in (ids only; already authorised). */
  scope?: StoredScope;
  /** Candidates fetched and documents used by retrieval. */
  retrieval?: AskRetrieval;
  /** Timings of an answered turn. */
  timings?: { totalMs: number; firstBlockMs?: number };
}

/** A scoped collection; `name` only while the reader can access it. */
export interface PresentedScopeCollection {
  id: string;
  name?: string;
}

/** A scoped document; `title` only while the reader can read it. */
export interface PresentedScopeDocument {
  id: string;
  title?: string;
}

/** The scope of a stored turn, re-authorised for the reader. */
export interface PresentedScope {
  collections: PresentedScopeCollection[];
  documents: PresentedScopeDocument[];
  dateFrom?: string;
  dateTo?: string;
}

/** A stored block that may no longer be shown. */
export interface HiddenBlock {
  hidden: true;
  kind: string;
}

/** A stored block as the owner may see it now. */
export interface VisibleBlock {
  kind: string;
  markdown: string;
  citations: AskCitation[];
}

/** A stored turn, re-authorised for the reader. */
export interface PresentedTurn {
  id: string;
  position: number;
  question: string;
  outcome: string;
  usageId: string | null;
  /** Blocks the verifier dropped from this answer; 0 when all were kept. */
  droppedSegments: number;
  createdAt: Date;
  /** Readable cited documents, numbered as the block citations reference them. */
  sources: AskSource[];
  blocks: (VisibleBlock | HiddenBlock)[];
  /** True when the turn cites a document the reader can no longer read. */
  hasHiddenBlocks: boolean;
  /** The scope the question was asked in, when it had one. */
  scope?: PresentedScope;
  /** Timings of an answered turn, when stored. */
  timings?: { totalMs: number; firstBlockMs?: number };
  /** Retrieval counts, when stored. */
  retrieval?: AskRetrieval;
  /** Set when the question was asked in compare mode. */
  mode?: "compare";
}

/**
 * The configured retention in days.
 *
 * @param value the raw setting; defaults to `AI_HISTORY_RETENTION_DAYS`.
 * @returns a whole number of days between 1 and 365; 90 when unset or invalid.
 */
export function retentionDays(
  value: string | undefined = env.AI_HISTORY_RETENTION_DAYS
): number {
  const trimmed = value?.trim() ?? "";
  if (!/^\d+$/.test(trimmed)) {
    return DEFAULT_RETENTION_DAYS;
  }
  return Math.min(Math.max(Number(trimmed), 1), 365);
}

/**
 * A conversation title: redacted, whitespace collapsed, at most 80 characters.
 *
 * @param text the first question or a title chosen by the owner.
 * @returns the title; "Untitled" when nothing is left.
 */
export function conversationTitle(text: string): string {
  const title = [...redactSecrets(text).text.replace(/\s+/g, " ").trim()]
    .slice(0, MAX_TITLE_CHARS)
    .join("")
    .trim();
  return title || "Untitled";
}

/**
 * Stores one turn of an AI conversation, creating the conversation when
 * needed, and bumps its activity time. Only verified blocks are stored, with
 * the question and every text redacted again. Never throws.
 *
 * @param user the user who asked.
 * @param input the question, the released blocks and how the turn ended.
 * @returns the conversation id, or null when nothing was stored (history off,
 * someone else's conversation, the turn cap reached, or a failure).
 */
export async function appendConversationTurn(
  user: User,
  input: StoreTurnInput
): Promise<string | null> {
  try {
    if (!isHistoryEnabled(user.team)) {
      return null;
    }
    const requestedId =
      input.conversationId && isUUID(input.conversationId)
        ? input.conversationId
        : undefined;
    const { blocks, citedDocumentIds } = toStoredBlocks(input.released);
    const question = [...redactSecrets(input.question).text]
      .slice(0, MAX_QUESTION_CHARS)
      .join("");

    return await sequelize.transaction(async (transaction) => {
      const values = {
        teamId: user.teamId,
        userId: user.id,
        title: conversationTitle(input.title || input.question),
      };
      let conversation: AIConversation | null;
      if (requestedId) {
        if (input.create) {
          // ON CONFLICT DO NOTHING: an existing row (anyone's) is left alone
          // and a concurrent insert is waited for instead of failing.
          await AIConversation.bulkCreate([{ ...values, id: requestedId }], {
            ignoreDuplicates: true,
            transaction,
          });
        }
        // The row lock serialises turns, so positions stay consecutive. A
        // foreign, unknown or deleted id is not found and stores nothing.
        conversation = await AIConversation.findOne({
          where: { id: requestedId, teamId: user.teamId, userId: user.id },
          lock: transaction.LOCK.UPDATE,
          transaction,
        });
      } else {
        conversation = await AIConversation.create(values, { transaction });
      }
      if (!conversation) {
        return null;
      }
      const position = await AIConversationTurn.count({
        where: {
          conversationId: conversation.id,
          teamId: user.teamId,
          userId: user.id,
        },
        transaction,
      });
      if (position >= MAX_STORED_TURNS) {
        Logger.warn("AI answers conversation reached its turn limit", {
          turns: position,
        });
        return null;
      }
      await AIConversationTurn.create(
        {
          conversationId: conversation.id,
          teamId: user.teamId,
          userId: user.id,
          position,
          question,
          blocks,
          citedDocumentIds,
          outcome: input.outcome,
          usageId: input.usageId,
          droppedSegments:
            clampCount(input.droppedSegments ?? 0, MAX_SMALLINT) ?? 0,
          scope: storedScope(input.scope),
          totalMs: clampCount(input.timings?.totalMs, MAX_INTEGER),
          firstBlockMs: clampCount(input.timings?.firstBlockMs, MAX_INTEGER),
          retrievalFetched: clampCount(input.retrieval?.fetched, MAX_SMALLINT),
          retrievalUsed: clampCount(input.retrieval?.used, MAX_SMALLINT),
        },
        { transaction }
      );
      conversation.changed("updatedAt", true);
      await conversation.save({ transaction });
      return conversation.id;
    });
  } catch {
    Logger.warn("AI answers could not store a conversation turn", {
      blocks: input.released.length,
    });
    return null;
  }
}

/**
 * One of the user's stored conversations in the shape of the Redis store, to
 * seed it when an old conversation is continued. Only the newest turns are
 * kept; a turn citing a source the user can no longer read is left out,
 * question included.
 *
 * @param user the owner.
 * @param id the conversation id.
 * @returns the conversation, or null when it is missing, foreign or unreadable.
 */
export async function getConversationForResume(
  user: User,
  id: string
): Promise<Conversation | null> {
  if (!isUUID(id)) {
    return null;
  }
  try {
    const conversation = await findOwnConversation(user, id);
    if (!conversation) {
      return null;
    }
    const turns = (await findTurns(user, id)).slice(-MAX_TURNS);
    const presented = await presentTurns(user, turns);
    return {
      id,
      teamId: user.teamId,
      userId: user.id,
      // A hidden turn feeds nothing back, not even its question.
      turns: presented.flatMap((turn, i) => {
        if (turn.hasHiddenBlocks) {
          return [];
        }
        const answer = joinBlockMarkdown(
          turn.blocks.filter((b): b is VisibleBlock => !("hidden" in b))
        );
        const keep = answer.trim() !== "" && answer.length <= MAX_ANSWER_CHARS;
        return [
          {
            question: turn.question,
            answer: keep ? answer : null,
            citedDocumentIds: keep ? turns[i].citedDocumentIds : [],
            at: turn.createdAt.getTime(),
          },
        ];
      }),
    };
  } catch {
    Logger.warn("AI answers could not load a stored conversation");
    return null;
  }
}

/**
 * Finds one of the user's conversations, scoped explicitly by team and owner.
 *
 * @param user the owner.
 * @param id the conversation id.
 * @returns the conversation, or null for missing and foreign ids alike.
 */
export async function findOwnConversation(
  user: User,
  id: string
): Promise<AIConversation | null> {
  return AIConversation.findOne({
    where: { id, teamId: user.teamId, userId: user.id },
  });
}

/**
 * The turns of one of the user's conversations, oldest first.
 *
 * @param user the owner.
 * @param conversationId the conversation id.
 * @returns the turns.
 */
export async function findTurns(
  user: User,
  conversationId: string
): Promise<AIConversationTurn[]> {
  return AIConversationTurn.findAll({
    where: { conversationId, teamId: user.teamId, userId: user.id },
    order: [["position", "ASC"]],
  });
}

/**
 * Re-authorises stored turns for the reader: a block citing any document the
 * reader cannot read now (deleted, no permission, unpublished, template or
 * excluded from AI) is hidden without its text. Titles and urls are resolved
 * fresh and redacted; nothing about hidden documents is returned.
 *
 * @param user the reader, who must be the owner.
 * @param turns the stored turns.
 * @returns the turns as they may be shown.
 */
export async function presentTurns(
  user: User,
  turns: AIConversationTurn[]
): Promise<PresentedTurn[]> {
  const scopes = turns.map((t) => t.scope).filter((x) => !!x);
  const readable = await readableDocuments(user, [
    ...turns.flatMap((t) => t.citedDocumentIds),
    ...scopes.flatMap((x) => x.documentIds),
  ]);
  const [details, collections] = await Promise.all([
    presentSourceDetails(user, [...readable.values()]),
    accessibleCollections(
      user,
      scopes.flatMap((x) => x.collectionIds)
    ),
  ]);
  return turns.map((turn) => {
    const sources: AskSource[] = [];
    const sourceOf = (documentId: string): AskSource => {
      const found = sources.find((s) => s.documentId === documentId);
      if (found) {
        return found;
      }
      const document = readable.get(documentId);
      const title = redactSecrets(document?.title || "Untitled").text;
      const source = {
        n: sources.length + 1,
        documentId,
        title,
        url: Document.getPath({ title, urlId: document?.urlId ?? "" }),
        ...details.get(documentId),
      };
      sources.push(source);
      return source;
    };
    // One unreadable source hides the whole turn: uncited blocks (headings,
    // lead-ins) are derived from the same sources. Fails closed with the map.
    const turnReadable = [
      ...turn.citedDocumentIds,
      ...(turn.blocks ?? []).flatMap((b) =>
        b.citations.map((c) => c.documentId)
      ),
    ].every((id) => readable.has(id));
    const blocks = (turn.blocks ?? []).map(
      (block): VisibleBlock | HiddenBlock => {
        if (!turnReadable) {
          return { hidden: true, kind: block.kind };
        }
        return {
          kind: block.kind,
          markdown: block.markdown,
          citations: block.citations.map((c) => {
            const source = sourceOf(c.documentId);
            const target = safeCitationTarget(c);
            return {
              n: source.n,
              documentId: c.documentId,
              title: source.title,
              url: target.anchor
                ? `${source.url}#${target.anchor}`
                : source.url,
              ...(target.heading ? { heading: target.heading } : {}),
              ...(c.quote ? { quote: c.quote } : {}),
            };
          }),
        };
      }
    );
    return {
      id: turn.id,
      position: turn.position,
      question: turn.question,
      outcome: turn.outcome,
      usageId: turn.usageId,
      droppedSegments: turn.droppedSegments,
      createdAt: turn.createdAt,
      sources,
      blocks,
      hasHiddenBlocks: blocks.some((b) => "hidden" in b),
      ...(turn.scope
        ? {
            scope: {
              collections: turn.scope.collectionIds.map((id) => {
                const name = collections.get(id)?.name;
                return name ? { id, name } : { id };
              }),
              documents: turn.scope.documentIds.map((id) => {
                const document = readable.get(id);
                return document
                  ? {
                      id,
                      title: redactSecrets(document.title || "Untitled").text,
                    }
                  : { id };
              }),
              ...(turn.scope.dateFrom ? { dateFrom: turn.scope.dateFrom } : {}),
              ...(turn.scope.dateTo ? { dateTo: turn.scope.dateTo } : {}),
            },
          }
        : {}),
      ...(turn.scope?.mode === "compare" ? { mode: "compare" as const } : {}),
      ...(turn.totalMs !== null
        ? {
            timings: {
              totalMs: turn.totalMs,
              ...(turn.firstBlockMs !== null
                ? { firstBlockMs: turn.firstBlockMs }
                : {}),
            },
          }
        : {}),
      ...(turn.retrievalFetched !== null && turn.retrievalUsed !== null
        ? {
            retrieval: {
              fetched: turn.retrievalFetched,
              used: turn.retrievalUsed,
            },
          }
        : {}),
    };
  });
}

/**
 * The scope as stored: valid ids only, capped, dates kept as given; null
 * when nothing is scoped.
 */
function storedScope(scope: StoredScope | undefined): StoredScope | null {
  if (!scope) {
    return null;
  }
  const ids = (list: string[], max: number) =>
    [...new Set(list.filter((id) => isUUID(id)))].slice(0, max);
  const stored: StoredScope = {
    collectionIds: ids(scope.collectionIds, MAX_SCOPE_COLLECTIONS),
    documentIds: ids(scope.documentIds, MAX_SCOPE_DOCUMENTS),
    ...(scope.dateFrom ? { dateFrom: scope.dateFrom } : {}),
    ...(scope.dateTo ? { dateTo: scope.dateTo } : {}),
    ...(scope.mode === "compare" ? { mode: "compare" as const } : {}),
  };
  const empty =
    stored.collectionIds.length === 0 &&
    stored.documentIds.length === 0 &&
    !stored.dateFrom &&
    !stored.dateTo &&
    !stored.mode;
  return empty ? null : stored;
}

/**
 * The released blocks as stored: kind, redacted Markdown and citations. An
 * answer too long or citing too many documents to re-check is dropped whole,
 * like in the Redis store.
 */
function toStoredBlocks(released: AcceptedBlock[]): {
  blocks: StoredBlock[];
  citedDocumentIds: string[];
} {
  const blocks = released.map((r): StoredBlock => ({
    kind: r.block.kind,
    markdown: redactSecrets(blockToMarkdown(r.block)).text,
    citations: r.citations.map((c): StoredCitation => {
      const quote = redactSecrets(c.quote).text;
      const { anchor, heading } = safeCitationTarget({
        anchor: c.anchor,
        heading: c.headingText,
      });
      return {
        documentId: c.documentId,
        ...(quote ? { quote } : {}),
        ...(heading ? { heading } : {}),
        ...(anchor ? { anchor } : {}),
      };
    }),
  }));
  const citedDocumentIds = [
    ...new Set(blocks.flatMap((b) => b.citations.map((c) => c.documentId))),
  ];
  if (
    joinBlockMarkdown(blocks).length > MAX_ANSWER_CHARS ||
    citedDocumentIds.length > MAX_CITED_DOCUMENTS
  ) {
    return { blocks: [], citedDocumentIds: [] };
  }
  return { blocks, citedDocumentIds };
}
