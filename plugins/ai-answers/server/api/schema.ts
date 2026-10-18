import { z } from "zod";
import { BaseSchema } from "@server/routes/api/schema";

export const AIAskSchema = BaseSchema.extend({
  body: z.object({
    /** The question, exactly as the user asked it. */
    query: z.string().trim().min(1).max(500),
    /** The conversation to continue; unknown or expired ids start a new one. */
    conversationId: z.uuid().optional(),
    /** Only use documents in this collection. */
    collectionId: z.uuid().optional(),
    /** Only use this document and its children. */
    documentId: z.uuid().optional(),
  }),
});

export type AIAskReq = z.infer<typeof AIAskSchema>;

export const AIFeedbackSchema = BaseSchema.extend({
  body: z.object({
    /** The `usageId` of the answer's `done` event. */
    usageId: z.uuid(),
    /** "clear" removes an earlier rating. */
    rating: z.enum(["up", "down", "clear"]),
  }),
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
