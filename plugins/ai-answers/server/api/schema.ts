import { z } from "zod";
import { AIFeedbackReasons } from "@server/models/AIAnswerUsage";
import { BaseSchema } from "@server/routes/api/schema";
import { MAX_SCOPE_COLLECTIONS, MAX_SCOPE_DOCUMENTS } from "../retrieve";

const countUnique = (one: string | undefined, many: string[] | undefined) =>
  new Set([...(one ? [one] : []), ...(many ?? [])]).size;

export const AIAskSchema = BaseSchema.extend({
  body: z
    .object({
      /** The question, exactly as the user asked it. */
      query: z.string().trim().min(1).max(500),
      /** The conversation to continue; unknown or expired ids start a new one. */
      conversationId: z.uuid().optional(),
      /** Only use documents in this collection (merged with `collectionIds`). */
      collectionId: z.uuid().optional(),
      /** Only use documents in any of these collections. */
      collectionIds: z.array(z.uuid()).max(MAX_SCOPE_COLLECTIONS).optional(),
      /** Only use this document and its children (merged with `documentIds`). */
      documentId: z.uuid().optional(),
      /** Only use these documents and their children. */
      documentIds: z.array(z.uuid()).max(MAX_SCOPE_DOCUMENTS).optional(),
      /** Only use documents updated on or after this UTC day (YYYY-MM-DD). */
      dateFrom: z.iso.date().optional(),
      /** Only use documents updated on or before this UTC day (YYYY-MM-DD). */
      dateTo: z.iso.date().optional(),
      /** "compare" answers with a table of values quoted from each source. */
      mode: z.enum(["answer", "compare"]).default("answer"),
    })
    .refine((b) => !b.dateFrom || !b.dateTo || b.dateFrom <= b.dateTo, {
      message: "dateFrom must not be after dateTo",
    })
    .refine(
      (b) =>
        countUnique(b.collectionId, b.collectionIds) <= MAX_SCOPE_COLLECTIONS,
      { message: `At most ${MAX_SCOPE_COLLECTIONS} collections` }
    )
    .refine(
      (b) => countUnique(b.documentId, b.documentIds) <= MAX_SCOPE_DOCUMENTS,
      { message: `At most ${MAX_SCOPE_DOCUMENTS} documents` }
    ),
});

export type AIAskReq = z.infer<typeof AIAskSchema>;

export const AIFeedbackSchema = BaseSchema.extend({
  body: z
    .object({
      /** The `usageId` of the answer's `done` event. */
      usageId: z.uuid(),
      /** "clear" removes an earlier rating. */
      rating: z.enum(["up", "down", "clear"]),
      /** Why the answer was not helpful; only with "down". */
      reason: z.enum(AIFeedbackReasons).optional(),
      /** Free text on a "down" rating; redacted before it is stored. */
      comment: z.string().trim().max(500).optional(),
    })
    .refine(
      (b) =>
        b.rating === "down" ||
        (b.reason === undefined && b.comment === undefined),
      { message: "reason and comment are only allowed with a down rating" }
    ),
});

export type AIFeedbackReq = z.infer<typeof AIFeedbackSchema>;

export const AIConversationsListSchema = BaseSchema.extend({
  body: z.object({
    /** Matches the title and the questions, case-insensitively. */
    query: z.string().trim().max(100).optional(),
    /** Only pinned (true) or only unpinned (false) conversations. */
    pinned: z.boolean().optional(),
  }),
});

export type AIConversationsListReq = z.infer<typeof AIConversationsListSchema>;

export const AIConversationsInfoSchema = BaseSchema.extend({
  body: z.object({
    id: z.uuid(),
  }),
});

export type AIConversationsInfoReq = z.infer<typeof AIConversationsInfoSchema>;

export const AIConversationsUpdateSchema = BaseSchema.extend({
  body: z
    .object({
      id: z.uuid(),
      /** Redacted on write. */
      title: z.string().trim().min(1).max(80).optional(),
      pinned: z.boolean().optional(),
    })
    .refine((body) => body.title !== undefined || body.pinned !== undefined, {
      message: "title or pinned is required",
    }),
});

export type AIConversationsUpdateReq = z.infer<
  typeof AIConversationsUpdateSchema
>;

export const AIConversationsDeleteSchema = BaseSchema.extend({
  body: z.object({
    id: z.uuid(),
  }),
});

export type AIConversationsDeleteReq = z.infer<
  typeof AIConversationsDeleteSchema
>;

export const AIDocumentsSchema = BaseSchema.extend({
  body: z.object({
    /** Matches document titles, case-insensitively; empty lists recent ones. */
    query: z.string().trim().max(100).optional(),
    /** Most documents to return. */
    limit: z.number().int().min(1).max(20).default(20),
  }),
});

export type AIDocumentsReq = z.infer<typeof AIDocumentsSchema>;
