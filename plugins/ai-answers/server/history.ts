import isUUID from "validator/lib/isUUID";
import Logger from "@server/logging/Logger";
import { AIConversation, AIConversationTurn, Document } from "@server/models";
import type { User } from "@server/models";
import type {
  StoredBlock,
  StoredCitation,
} from "@server/models/AIConversationTurn";
import { sequelize } from "@server/storage/database";
import { isHistoryEnabled } from "./access";
import type { AskCitation, AskSource } from "./api/ask";
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
import { redactSecrets } from "./redact";
import type { AcceptedBlock } from "./verify";

/** Days a conversation is kept after its last activity, unless configured. */
export const DEFAULT_RETENTION_DAYS = 90;

/** Most turns a stored conversation may hold. */
export const MAX_STORED_TURNS = 100;

/** Longest conversation title, in characters. */
export const MAX_TITLE_CHARS = 80;

/** An editor heading id (`safeSlugify` output plus an occurrence suffix). */
const SAFE_ANCHOR = /^h-[A-Za-z0-9%-]{0,200}$/;

/** What `ai.ask` hands over to store a turn: never free-form model text. */
export interface StoreTurnInput {
  /** The conversation to continue; a new one is created when omitted. */
  conversationId?: string | null;
  /**
   * True when `ai.ask` minted `conversationId` in this request, so the row is
   * created with it. Otherwise only an existing row is continued: a deleted
   * conversation is never recreated by a late turn.
   */
  create?: boolean;
  /** The user's original question; redacted and truncated before storing. */
  question: string;
  /** The verifier's released blocks (`AnswerVerifier.released`); [] when failed. */
  released: AcceptedBlock[];
  /** "answered", or the `ai.ask` failure reason. */
  outcome: string;
  /** The metered usage row of the answer, if any. */
  usageId: string | null;
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
  createdAt: Date;
  /** Readable cited documents, numbered as the block citations reference them. */
  sources: AskSource[];
  blocks: (VisibleBlock | HiddenBlock)[];
  /** True when the turn cites a document the reader can no longer read. */
  hasHiddenBlocks: boolean;
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
        title: conversationTitle(input.question),
      };
      let conversation: AIConversation | null;
      if (requestedId && !input.create) {
        // The row lock serialises turns, so positions stay consecutive. A
        // foreign, unknown or deleted id is not found and stores nothing.
        conversation = await AIConversation.findOne({
          where: { id: requestedId, teamId: user.teamId, userId: user.id },
          lock: transaction.LOCK.UPDATE,
          transaction,
        });
      } else {
        // An id taken by anyone fails on the primary key and stores nothing.
        conversation = await AIConversation.create(
          requestedId ? { ...values, id: requestedId } : values,
          { transaction }
        );
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
 * kept, and an answer only when every block of it is still readable.
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
      turns: presented.map((turn, i) => {
        const answer = joinBlockMarkdown(
          turn.blocks.filter((b): b is VisibleBlock => !("hidden" in b))
        );
        const keep =
          !turn.hasHiddenBlocks &&
          answer.trim() !== "" &&
          answer.length <= MAX_ANSWER_CHARS;
        return {
          question: turn.question,
          answer: keep ? answer : null,
          citedDocumentIds: keep ? turns[i].citedDocumentIds : [],
          at: turn.createdAt.getTime(),
        };
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
  const readable = await readableDocuments(
    user,
    turns.flatMap((t) => t.citedDocumentIds)
  );
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
            return {
              n: source.n,
              documentId: c.documentId,
              title: source.title,
              url:
                c.anchor && SAFE_ANCHOR.test(c.anchor)
                  ? `${source.url}#${c.anchor}`
                  : source.url,
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
      createdAt: turn.createdAt,
      sources,
      blocks,
      hasHiddenBlocks: blocks.some((b) => "hidden" in b),
    };
  });
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
      const anchor = c.anchor && SAFE_ANCHOR.test(c.anchor) ? c.anchor : "";
      return {
        documentId: c.documentId,
        ...(quote ? { quote } : {}),
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
