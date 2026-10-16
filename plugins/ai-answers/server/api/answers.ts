import Router from "koa-router";
import { TeamPreference } from "@shared/types";
import { toError } from "@shared/utils/error";
import { AuthorizationError } from "@server/errors";
import Logger from "@server/logging/Logger";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import timeout from "@server/middlewares/timeout";
import validate from "@server/middlewares/validate";
import { presentDocument, presentPolicies } from "@server/presenters";
import type { User } from "@server/models";
import type { APIContext } from "@server/types";
import { releaseRequestTransaction } from "@server/storage/requestContext";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import { getClient } from "../anthropicClient";
import {
  CLIENT_TIMEOUT_MS,
  DEFAULT_DEADLINE_MS,
  MIN_DEADLINE_MS,
  ZERO_USAGE,
} from "../contract";
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

/**
 * Time allowed for retrieval, serialising documents and writing the response
 * on top of the answer deadline. The socket timeout of this route is the
 * deadline plus this headroom.
 */
const REQUEST_HEADROOM_MS = 15_000;

const NO_ANSWER_RESULT: AnswerResult = { answer: null, citations: [] };

/**
 * The configured answer deadline, clamped so a bad value can never throw or
 * abort instantly.
 *
 * @param value the configured deadline in milliseconds.
 * @returns a deadline between the minimum and the client timeout.
 */
export function clampDeadline(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_DEADLINE_MS;
  }
  return Math.min(Math.max(value, MIN_DEADLINE_MS), CLIENT_TIMEOUT_MS);
}

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
  sources: AnswerSource[],
  clientGone: AbortSignal
): Promise<AnswerResult> {
  // Nobody is waiting any more (e.g. the client left during retrieval).
  if (clientGone.aborted) {
    return NO_ANSWER_RESULT;
  }
  // Aborts on disconnect or when the hard deadline for the model call passes.
  // CLIENT_MAX_RETRIES must stay 0: this abort/billing path assumes exactly one
  // billed call per request.
  const signal = AbortSignal.any([
    clientGone,
    AbortSignal.timeout(clampDeadline(env.AI_ANSWERS_DEADLINE_MS)),
  ]);
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

  // Aborted while reserving: no request was sent, so nothing was billed.
  if (signal.aborted) {
    await reservation.release();
    return NO_ANSWER_RESULT;
  }

  const startedAt = Date.now();
  try {
    const { answer, citations, droppedSegments, abstained, usage } =
      await generateAnswerWithUsage(getClient(), query, sources, signal);
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
      aborted: signal.aborted,
    });
    // Billing for a failed or aborted call is unknown: assume the worst case.
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

// Request timeout, as it applies to this route:
// - server/main.ts:146 calls `server.setTimeout(env.REQUEST_TIMEOUT)` (default
//   10 s, server/env.ts:328). That is Node's socket *idle* timeout: with no
//   "timeout" listener anywhere in server/, Node destroys the socket after 10 s
//   without bytes in either direction. A response not started by then is never
//   delivered, and the Caddy proxy reports 502 (deploy/caddy/Caddyfile sets no
//   response timeout of its own, so 502 comes from the destroyed socket).
// - The `timeout` middleware (server/middlewares/timeout.ts) raises the idle
//   timeout of this socket for one request, so retrieval plus the answer
//   deadline fits. The Postgres statement_timeout (REQUEST_TIMEOUT - 500 ms,
//   server/storage/database.ts:76) is unaffected and still bounds each query.
router.post(
  "documents.answerQuestion",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  // After auth so unauthenticated and rate-limited requests keep the default window.
  timeout(clampDeadline(env.AI_ANSWERS_DEADLINE_MS) + REQUEST_HEADROOM_MS),
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

    // Abort the model call when the client goes away before the response is
    // written, so it stops billing and frees its concurrency slot.
    const clientGone = new AbortController();
    const handleClose = () => {
      if (!ctx.res.writableFinished) {
        clientGone.abort();
      }
    };
    // `res` close, not `req`: req emits "close" once the body is read, res only when the connection ends or the response finishes.
    ctx.res.once("close", handleClose);

    try {
      const sources = await retrieveSources(user, ctx.input.body);
      const documents = sources.map((source) => source.document);
      // Presenting reads tenant data, so it must run before the release below.
      const presented = await Promise.all(
        documents.map((document) => presentDocument(ctx, document))
      );
      const policies = presentPolicies(user, documents);

      // Return the request's pinned connection before the slow model call
      // (task 1.2). No tenant-data reads after this point: the queries below
      // (usage metering) take teamId explicitly and never used the request
      // transaction. If the release fails, answer with documents only.
      let released = false;
      try {
        await releaseRequestTransaction();
        released = true;
      } catch (error) {
        Logger.warn("AI answers could not release the request transaction", {
          error: toError(error).message,
        });
      }

      // Generation is best-effort: fall back to the retrieved documents alone.
      const { answer, citations } =
        released && sources.length > 0
          ? await answerWithinLimits(user, query, sources, clientGone.signal)
          : NO_ANSWER_RESULT;

      ctx.body = {
        documents: presented,
        policies,
        // Returned to the client, never persisted; the plain search logs the query.
        answer,
        citations,
      };
    } finally {
      ctx.res.off("close", handleClose);
    }
  }
);

export default router;
