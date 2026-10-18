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
