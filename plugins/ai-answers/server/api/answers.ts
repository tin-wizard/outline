import Router from "koa-router";
import { TeamPreference } from "@shared/types";
import { toError } from "@shared/utils/error";
import { AuthorizationError } from "@server/errors";
import Logger from "@server/logging/Logger";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import validate from "@server/middlewares/validate";
import { presentDocument, presentPolicies } from "@server/presenters";
import type { User } from "@server/models";
import type { APIContext } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import { getClient } from "../anthropicClient";
import { ZERO_USAGE } from "../contract";
import env from "../env";
import { generateAnswerWithUsage, type AnswerResult } from "../generate";
import { retrieveSources, type AnswerSource } from "../retrieve";
import {
  estimateUsage,
  markUnmetered,
  recordUsage,
  reserveModelCall,
  type UsageEntry,
} from "../usage";
import * as T from "./schema";

const router = new Router();

const NO_ANSWER_RESULT: AnswerResult = { answer: null, citations: [] };

/** Records usage; a failure is logged, never allowed to break the response. */
async function record(entry: UsageEntry) {
  try {
    await recordUsage(entry);
  } catch {
    Logger.warn("AI answers usage could not be recorded", {
      outcome: entry.outcome,
      inputTokens: entry.usage.inputTokens,
      outputTokens: entry.usage.outputTokens,
    });
    // Unrecorded spend breaks the budget: stop calling the model for now.
    await markUnmetered(entry.teamId);
  }
}

/**
 * Calls the model only when the workspace is under its monthly budget and
 * concurrency cap, and meters the call. Fails closed: if the limits cannot be
 * checked there is no model call, and if the cost of a call is unknown a
 * conservative estimate is recorded instead of zero.
 */
async function answerWithinLimits(
  user: User,
  query: string,
  sources: AnswerSource[]
): Promise<AnswerResult> {
  const base = {
    teamId: user.teamId,
    userId: user.id,
    model: env.AI_ANSWERS_MODEL,
  };
  const reservation = await reserveModelCall(user.teamId);
  if (!reservation.ok) {
    if (reservation.reason === "budget") {
      await record({ ...base, usage: ZERO_USAGE, outcome: "budget_blocked" });
    }
    return NO_ANSWER_RESULT;
  }

  const startedAt = Date.now();
  try {
    const { answer, citations, droppedSegments, abstained, usage } =
      await generateAnswerWithUsage(getClient(), query, sources);
    if (!usage) {
      Logger.warn("AI answers response lacked usage; recording an estimate");
    }
    await record({
      ...base,
      usage: usage ?? estimateUsage(query, sources),
      outcome: answer
        ? "answered"
        : abstained
          ? "no_answer"
          : droppedSegments > 0
            ? "dropped"
            : "no_answer",
      droppedSegments,
      durationMs: Date.now() - startedAt,
    });
    return { answer, citations };
  } catch (error) {
    Logger.warn("AI answers generation failed", {
      error: toError(error).message,
    });
    // Billing for a failed call is unknown: assume the worst case.
    await record({
      ...base,
      usage: estimateUsage(query, sources),
      outcome: "error",
      durationMs: Date.now() - startedAt,
    });
    return NO_ANSWER_RESULT;
  } finally {
    await reservation.release();
  }
}

router.post(
  "documents.answerQuestion",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  validate(T.DocumentsAnswerQuestionSchema),
  async (ctx: APIContext<T.DocumentsAnswerQuestionReq>) => {
    const { user } = ctx.state.auth;
    const { query } = ctx.input.body;

    if (!user.team.getPreference(TeamPreference.AIAnswers)) {
      throw AuthorizationError("AI answers are not enabled for this workspace");
    }

    // Owner decision D8: members and admins only. Guests and viewers still get
    // normal search, just no AI answers.
    if (user.isGuest || user.isViewer) {
      throw AuthorizationError("AI answers are not available for your role");
    }

    const sources = await retrieveSources(user, ctx.input.body);
    const documents = sources.map((source) => source.document);

    // Generation is best-effort: fall back to the retrieved documents alone.
    const { answer, citations } =
      sources.length > 0
        ? await answerWithinLimits(user, query, sources)
        : NO_ANSWER_RESULT;

    ctx.body = {
      documents: await Promise.all(
        documents.map((document) => presentDocument(ctx, document))
      ),
      policies: presentPolicies(user, documents),
      // Returned to the client, never persisted; the plain search logs the query.
      answer,
      citations,
    };
  }
);

export default router;
