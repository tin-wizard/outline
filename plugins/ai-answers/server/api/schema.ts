import { z } from "zod";
import { StatusFilter } from "@shared/types";
import { BaseSchema } from "@server/routes/api/schema";

export const DocumentsAnswerQuestionSchema = BaseSchema.extend({
  body: z.object({
    /** The question to answer. */
    query: z.string().trim().min(1).max(500),
    /** Only use documents edited by this user. */
    userId: z.uuid().optional(),
    /** Only use documents in this collection. */
    collectionId: z.uuid().optional(),
    /** Only use this document and its children. */
    documentId: z.uuid().optional(),
    /** Only use documents in these statuses. */
    statusFilter: z.enum(StatusFilter).array().optional(),
    /** Only use documents updated within this period. */
    dateFilter: z.enum(["day", "week", "month", "year"]).optional(),
  }),
});

export type DocumentsAnswerQuestionReq = z.infer<
  typeof DocumentsAnswerQuestionSchema
>;
