import { randomUUID } from "node:crypto";
import Router from "koa-router";
import { toError } from "@shared/utils/error";
import { NotFoundError } from "@server/errors";
import Logger from "@server/logging/Logger";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import timeout from "@server/middlewares/timeout";
import validate from "@server/middlewares/validate";
import { AIAnswerUsage, Document } from "@server/models";
import type { AIAnswerOutcome } from "@server/models/AIAnswerUsage";
import type { User } from "@server/models";
import type { APIContext } from "@server/types";
import { releaseRequestTransaction } from "@server/storage/requestContext";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import { assertAIAnswersAllowed, isHistoryEnabled } from "../access";
import { safeCitationTarget } from "../anchors";
import { getClient } from "../anthropicClient";
import {
  BlockSplitter,
  blockToMarkdown,
  type Block,
  type BlockKind,
} from "../blocks";
import {
  ASK_DEFAULT_DEADLINE_MS,
  ASK_DEFAULT_IDLE_MS,
  ASK_MAX_DEADLINE_MS,
  ASK_MAX_IDLE_MS,
  ASK_MIN_DEADLINE_MS,
  ASK_MIN_IDLE_MS,
  REQUEST_HEADROOM_MS,
  ZERO_USAGE,
  type FinishReason,
  type Usage,
} from "../contract";
import {
  appendTurn,
  buildStandaloneQuery,
  createConversation,
  historyForModel,
  loadConversation,
  seedConversation,
  type Conversation,
} from "../conversation";
import env from "../env";
import { appendConversationTurn, getConversationForResume } from "../history";
import { streamAnswer, type StreamProgress } from "../providers/anthropic";
import { redactSecrets } from "../redact";
import { presentSourceDetails, type SourceDetails } from "../presenters/source";
import { askScope, retrieveWithCounts, type AnswerSource } from "../retrieve";
import { estimateUsage, record, reserveModelCall } from "../usage";
import { AnswerVerifier, type AcceptedBlock } from "../verify";
import * as T from "./schema";

/** Why an answer ended without `done`. */
export type AskFailure =
  | "no_answer"
  | "unverified"
  | "budget"
  | "quota"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "scope_forbidden"
  | "error";

/** Extra facts about a failure; never names or ids of scoped content. */
export interface AskFailureDetail {
  /** For `budget` and `quota`: ISO time the limit resets (UTC). */
  resetsAt?: string;
}

/** Why a `notice` status was sent. */
export type AskNotice = "history_unavailable" | "conversation_new";

/** A retrieved document as the client may show it. */
export interface AskSource extends Partial<SourceDetails> {
  /** 1-based number, referenced by block citations. */
  n: number;
  documentId: string;
  title: string;
  url: string;
}

/** How many documents retrieval looked at and used for one answer. */
export interface AskRetrieval {
  /**
   * Readable, not AI-excluded candidates fetched before the cut, at most 20.
   * Not the number of matching documents.
   */
  fetched: number;
  /** Documents sent to the model (at most 5). */
  used: number;
}

/** A citation of one released block. */
export interface AskCitation {
  /** The `n` of the cited source. */
  n: number;
  documentId: string;
  title: string;
  /** The document url, with the cited section's heading anchor when known. */
  url: string;
  /** Plain visible text of the cited section's heading, when known. */
  heading?: string;
  quote?: string;
}

/** The events of the `ai.ask` stream and their `data` payloads. */
export interface AskEvents {
  conversation: { id: string };
  status: {
    phase: "searching" | "generating" | "notice";
    /** Stable code of a notice; map it to localised text on the client. */
    notice?: AskNotice;
    /** Fixed English text of a notice, not localised; prefer `notice`. */
    message?: string;
  };
  sources: AskSource[];
  block: {
    index: number;
    /** Lets the client join a table row to its header with a single newline. */
    kind: BlockKind;
    markdown: string;
    citations: AskCitation[];
  };
  done: {
    conversationId: string | null;
    /** The usage row to rate with `ai.feedback`; null when it could not be saved. */
    usageId: string | null;
    usage: Usage;
    timings: { retrievalMs: number; firstBlockMs?: number; totalMs: number };
    /** Blocks the verifier dropped from this answer; 0 when all were kept. */
    dropped: number;
    retrieval: AskRetrieval;
  };
  failed: { reason: AskFailure; partial: boolean; detail?: AskFailureDetail };
}

/** Comment line that keeps proxies and the socket idle timeout from closing a quiet stream. */
export const HEARTBEAT_MS = 10_000;

/**
 * The configured total cap of a streamed answer, clamped so a bad value can
 * never throw, abort instantly or outlive the concurrency slot.
 *
 * @param value the configured cap in milliseconds.
 * @returns a cap between 10 and 50 seconds.
 */
export function clampAskDeadline(value: number): number {
  if (!Number.isFinite(value)) {
    return ASK_DEFAULT_DEADLINE_MS;
  }
  return Math.min(Math.max(value, ASK_MIN_DEADLINE_MS), ASK_MAX_DEADLINE_MS);
}

/**
 * The configured idle limit of a streamed answer, clamped like the cap.
 *
 * @param value the configured limit in milliseconds.
 * @returns a limit between 1 and 30 seconds.
 */
export function clampAskIdle(value: number): number {
  if (!Number.isFinite(value)) {
    return ASK_DEFAULT_IDLE_MS;
  }
  return Math.min(Math.max(value, ASK_MIN_IDLE_MS), ASK_MAX_IDLE_MS);
}

/**
 * An abort signal that fires when `touch` is not called for `idleMs`, or
 * `totalMs` after creation, whichever comes first.
 *
 * @param idleMs the longest allowed gap between events.
 * @param totalMs the longest allowed total time.
 * @returns the signal, `touch` to restart the idle timer, and `stop`.
 */
export function streamLimits(idleMs: number, totalMs: number) {
  const controller = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const total = setTimeout(() => controller.abort(), totalMs);
  const touch = () => {
    clearTimeout(idle);
    if (!controller.signal.aborted) {
      idle = setTimeout(() => controller.abort(), idleMs);
    }
  };
  touch();
  return {
    signal: controller.signal,
    touch,
    stop() {
      clearTimeout(idle);
      clearTimeout(total);
    },
  };
}

const router = new Router();

/**
 * Opens a Server-Sent Events response on the raw socket. Koa does not send a
 * body (`respond = false`), so koa-compress, which only wraps `ctx.body`, never
 * compresses it; `no-transform` keeps proxies from doing so either.
 */
function openEventStream(ctx: APIContext<T.AIAskReq>) {
  ctx.respond = false;
  ctx.res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  // Node writes each chunk straight to the socket; disable Nagle so small
  // events are not held back.
  ctx.req.socket.setNoDelay(true);
  const open = () => !ctx.res.destroyed && !ctx.res.writableEnded;
  const write = (chunk: string) => {
    if (open()) {
      ctx.res.write(chunk);
    }
  };
  const heartbeat = setInterval(() => write(": heartbeat\n\n"), HEARTBEAT_MS);
  return {
    send<K extends keyof AskEvents>(event: K, data: AskEvents[K]) {
      // JSON escapes newlines, so the payload is always a single data line.
      write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      clearInterval(heartbeat);
      if (open()) {
        ctx.res.end();
      }
    },
  };
}

/**
 * When a monthly workspace budget (UTC calendar month) or a daily user quota
 * (UTC calendar day) resets.
 *
 * @param reason the limit that was reached.
 * @param now the current time.
 * @returns the ISO time of the next UTC month or day start.
 */
export function limitResetsAt(
  reason: "budget" | "quota",
  now = new Date()
): string {
  const [year, month, day] = [
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ];
  return new Date(
    reason === "budget"
      ? Date.UTC(year, month + 1, 1)
      : Date.UTC(year, month, day + 1)
  ).toISOString();
}

/** True for the error raised when a scoped collection or document is not readable. */
function isAuthorizationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "id" in error &&
    error.id === "authorization_error"
  );
}

/**
 * The sources as the client may show them: redacted titles, urls built from
 * the redacted title, and details (collection only when accessible, last
 * editor only when visible). Reads tenant data, so it runs before the
 * transaction is released.
 */
async function presentSources(
  user: User,
  sources: AnswerSource[]
): Promise<AskSource[]> {
  const details = await presentSourceDetails(
    user,
    sources.map((s) => s.document)
  );
  return sources.map((s, i) => {
    const title = redactSecrets(s.document.title || "Untitled").text;
    return {
      n: i + 1,
      documentId: s.document.id,
      title,
      url: Document.getPath({ title, urlId: s.document.urlId }),
      ...details.get(s.document.id),
    };
  });
}

/** Server-generated citations for a released block, pointing at sent sources only. */
function citationsOf(
  verdict: AcceptedBlock,
  sources: AskSource[]
): AskCitation[] {
  return verdict.citations.flatMap((c) => {
    const source = sources.find((s) => s.documentId === c.documentId);
    if (!source) {
      return [];
    }
    const quote = redactSecrets(c.quote).text;
    // Same rules as the stored history (see safeCitationTarget).
    const { anchor, heading } = safeCitationTarget({
      anchor: c.anchor,
      heading: c.headingText,
    });
    return [
      {
        n: source.n,
        documentId: source.documentId,
        title: source.title,
        url: anchor ? `${source.url}#${anchor}` : source.url,
        ...(heading ? { heading } : {}),
        ...(quote ? { quote } : {}),
      },
    ];
  });
}

// Streams one AI turn as Server-Sent Events over POST (precedent:
// server/routes/mcp/index.ts). Guards: the
// workspace preference, the role gate, abort on disconnect, a hard deadline,
// the request transaction released before the model call, and budget,
// unmetered flag and concurrency slot checked before any model call.
router.post(
  "ai.ask",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  validate(T.AIAskSchema),
  // After auth so unauthenticated and rate-limited requests keep the default window.
  timeout(clampAskDeadline(env.AI_ASK_DEADLINE_MS) + REQUEST_HEADROOM_MS),
  async (ctx: APIContext<T.AIAskReq>) => {
    const { user } = ctx.state.auth;
    const { query, conversationId } = ctx.input.body;
    const scope = askScope(ctx.input.body);

    assertAIAnswersAllowed(user);

    const startedAt = Date.now();
    const clientGone = new AbortController();
    const handleClose = () => {
      if (!ctx.res.writableFinished) {
        clientGone.abort();
      }
    };
    // `res` close, not `req`: req emits "close" once the body is read.
    ctx.res.once("close", handleClose);
    // A close before the listener was attached is never emitted again.
    if (ctx.res.destroyed || ctx.req.socket.destroyed) {
      ctx.res.off("close", handleClose);
      ctx.respond = false;
      return;
    }
    const stream = openEventStream(ctx);
    let emitted = 0;
    let usageId: string | null = null;

    try {
      // Conversation: an unknown, expired or foreign id starts a new one. With
      // stored history, an expired one of the user's own is resumed from the
      // database (re-authorised) and the hot cache rebuilt under the same id.
      const historyOn = isHistoryEnabled(user.team);
      let conversation: Conversation | null = null;
      let unavailable = false;
      if (conversationId) {
        const loaded = await loadConversation(user, conversationId);
        conversation = loaded.conversation;
        unavailable = loaded.unavailable;
        if (!conversation && historyOn) {
          const stored = await getConversationForResume(user, conversationId);
          if (stored) {
            conversation = await seedConversation(
              user,
              stored.id,
              stored.turns
            );
            unavailable = false;
          }
        }
      }
      if (!conversation && !unavailable) {
        conversation = await createConversation(user);
        unavailable = !conversation;
      }
      // With Redis down, stored history still keeps the turn under a new id.
      const id = conversation?.id ?? (historyOn ? randomUUID() : null);
      // An id minted in this request may create the stored conversation.
      const minted = id !== conversationId;
      // Blocks the verifier dropped (counted while streaming).
      let dropped = 0;
      // Set once retrieval ran; every stored turn has it.
      let retrieval: AskRetrieval = { fetched: 0, used: 0 };
      if (id) {
        stream.send("conversation", { id });
      }
      if (unavailable) {
        stream.send("status", {
          phase: "notice",
          notice: "history_unavailable",
          message:
            "Conversation history is unavailable, so this answer does not use earlier questions.",
        });
      } else if (conversationId && id !== conversationId) {
        stream.send("status", {
          phase: "notice",
          notice: "conversation_new",
          message:
            "The earlier conversation has expired. A new one was started.",
        });
      }
      stream.send("status", { phase: "searching" });

      /**
       * Stores the turn (only verified blocks; [] on failure) in the hot cache
       * and, with history on, the database, then ends the stream. Nothing is
       * stored once the client has gone. Runs after the request transaction
       * was released: the database write is scoped by team and user and reads
       * no other tenant data.
       */
      const finish = async (
        released: AcceptedBlock[],
        end:
          | { failed: AskFailure; detail?: AskFailureDetail }
          | {
              done: Omit<
                AskEvents["done"],
                "conversationId" | "usageId" | "dropped" | "retrieval"
              >;
            }
      ) => {
        let stored = false;
        if (id && !clientGone.signal.aborted) {
          // SET XX: true only while the user's own hot cache key is live, so
          // the id is theirs and not deleted (delete removes the key).
          const cached = await appendTurn(user, id, {
            question: query,
            released,
          });
          // A live key may create a missing row (e.g. the first answer was
          // stopped before anything was stored); otherwise only an existing
          // row is continued, so a deleted conversation stays deleted.
          // shortcut: a delete landing between the SET XX and this insert can
          // still be undone by it; a tombstone would close that window.
          const persisted = historyOn
            ? await appendConversationTurn(user, {
                conversationId: id,
                create: minted || cached,
                title: conversation?.turns[0]?.question,
                question: query,
                released,
                outcome: "failed" in end ? end.failed : "answered",
                usageId,
                droppedSegments: dropped,
                scope,
                retrieval,
                timings: "done" in end ? end.done.timings : undefined,
              })
            : null;
          stored = cached || persisted === id;
        }
        if ("failed" in end) {
          stream.send("failed", {
            reason: end.failed,
            partial: emitted > 0,
            ...(end.detail ? { detail: end.detail } : {}),
          });
        } else {
          // Only claim a conversation the turn was really stored in.
          stream.send("done", {
            ...end.done,
            conversationId: stored ? id : null,
            usageId,
            dropped,
            retrieval,
          });
        }
      };

      // History and the standalone query re-check permissions (tenant reads).
      const history = await historyForModel(user, conversation);
      const standalone = await buildStandaloneQuery(user, conversation, query);
      const retrievalStartedAt = Date.now();
      let sources: AnswerSource[];
      try {
        // The standalone query only drives retrieval; the model gets `query`.
        const found = await retrieveWithCounts(
          user,
          { ...ctx.input.body, query: standalone },
          clientGone.signal
        );
        sources = found.sources;
        retrieval = { fetched: found.candidatesFetched, used: sources.length };
      } catch (error) {
        if (clientGone.signal.aborted) {
          return;
        }
        // An unreadable, unknown or foreign scope id: one reason for all,
        // naming nothing, and nothing is stored since retrieval never ran.
        if (isAuthorizationError(error)) {
          stream.send("failed", { reason: "scope_forbidden", partial: false });
          return;
        }
        throw error;
      }
      const retrievalMs = Date.now() - retrievalStartedAt;
      const presented = await presentSources(user, sources);
      stream.send("sources", presented);

      // Return the pinned connection before the slow model call (M1 task
      // 1.2) and before storing the turn, which takes its own connection. No
      // tenant-data reads after this point.
      try {
        await releaseRequestTransaction();
      } catch (error) {
        Logger.warn("AI answers could not release the request transaction", {
          error: toError(error).message,
        });
        await finish([], { failed: "unavailable" });
        return;
      }
      if (sources.length === 0) {
        await finish([], { failed: "no_answer" });
        return;
      }

      // Nobody is waiting any more (the client left during retrieval).
      if (clientGone.signal.aborted) {
        return;
      }
      const base = {
        teamId: user.teamId,
        userId: user.id,
        model: env.AI_ANSWERS_MODEL,
      };
      // Worst-case input for a call whose usage is unknown, history included.
      const estimate = estimateUsage(
        [query, ...history.flatMap((t) => [t.question, t.answer ?? ""])].join(
          "\n"
        ),
        sources
      );
      const progress: StreamProgress = { inputTokens: null, outputChars: 0 };
      // A call cut short is billed for what it produced: input from
      // message_start (else the estimate) and the streamed text at 3 chars per
      // token, never the full output ceiling.
      const streamedUsage = (): Usage => ({
        inputTokens: progress.inputTokens ?? estimate.inputTokens,
        outputTokens: Math.max(1, Math.ceil(progress.outputChars / 3)),
      });
      // Built before the slot is taken, so a failure here cannot leak it.
      const verifier = new AnswerVerifier(sources);
      const splitter = new BlockSplitter();
      // CLIENT_MAX_RETRIES must stay 0: one billed call per request.
      const limits = streamLimits(
        clampAskIdle(env.AI_ASK_IDLE_MS),
        clampAskDeadline(env.AI_ASK_DEADLINE_MS)
      );
      const signal = AbortSignal.any([clientGone.signal, limits.signal]);
      const aborted = (): AskFailure =>
        clientGone.signal.aborted ? "cancelled" : "timeout";

      let reservation: Awaited<ReturnType<typeof reserveModelCall>>;
      try {
        reservation = await reserveModelCall(user.teamId, user.id);
      } catch (error) {
        limits.stop();
        throw error;
      }
      if (!reservation.ok) {
        limits.stop();
        const { reason } = reservation;
        if (reason === "budget" || reason === "quota") {
          await record({
            ...base,
            usage: ZERO_USAGE,
            outcome: reason === "budget" ? "budget_blocked" : "quota_blocked",
          });
        }
        await finish(
          [],
          reason === "budget" || reason === "quota"
            ? { failed: reason, detail: { resetsAt: limitResetsAt(reason) } }
            : { failed: "unavailable" }
        );
        return;
      }

      // Freed as soon as the model call is over, before billing (DB) and
      // storing the turn (Redis), so slow writes cannot hold the slot.
      const releaseReservation = reservation.release;
      let held = true;
      const freeSlot = async () => {
        if (held) {
          held = false;
          limits.stop();
          await releaseReservation();
        }
      };

      let allText = "";
      let finishReason: FinishReason = "other";
      let refused = false;
      let usage: Usage | null = null;
      let firstBlockMs: number | undefined;
      let sent = false;
      let recorded = false;
      const modelStartedAt = Date.now();
      const bill = async (entry: {
        usage: Usage;
        outcome: AIAnswerOutcome;
      }) => {
        recorded = true;
        usageId = await record({
          ...base,
          ...entry,
          droppedSegments: dropped,
          durationMs: Date.now() - modelStartedAt,
        });
      };
      const release = (blocks: Block[]) => {
        for (const block of blocks) {
          const verdict = verifier.verify(block);
          if (!verdict.ok) {
            dropped++;
            continue;
          }
          firstBlockMs ??= Date.now() - startedAt;
          stream.send("block", {
            index: emitted++,
            kind: verdict.block.kind,
            markdown: blockToMarkdown(verdict.block),
            citations: citationsOf(verdict, presented),
          });
        }
      };

      try {
        // Aborted while reserving: no request was sent, so nothing was billed.
        if (signal.aborted) {
          await freeSlot();
          await finish([], { failed: aborted() });
          return;
        }
        stream.send("status", { phase: "generating" });
        limits.touch();
        try {
          sent = true;
          for await (const event of streamAnswer(getClient(), {
            question: query,
            sources,
            history,
            signal,
            onEvent: limits.touch,
            progress,
          })) {
            if (event.type === "text") {
              allText += event.text;
              release(splitter.push(event.text, event.citations));
            } else {
              finishReason = event.finishReason;
              refused = event.refused;
              usage = event.usage;
            }
          }
          await freeSlot();
          release(splitter.flush());
        } catch (error) {
          Logger.warn("AI answers stream failed", {
            error: toError(error).message,
            aborted: signal.aborted,
          });
          await freeSlot();
          await bill({ usage: streamedUsage(), outcome: "error" });
          await finish([], { failed: signal.aborted ? aborted() : "error" });
          return;
        }

        const verdict = verifier.finish(finishReason, allText);
        let outcome: AIAnswerOutcome = "answered";
        let failure: AskFailure | undefined;
        if (refused) {
          outcome = "no_answer";
          failure = "no_answer";
        } else if (!verdict.ok) {
          if (verdict.reason === "abstained") {
            outcome = "no_answer";
            failure = "no_answer";
          } else if (verdict.reason === "unfinished") {
            // max_tokens, pause_turn or a stream cut before its end.
            outcome = "error";
            failure = "error";
          } else {
            // Text was written but not enough of it could be verified.
            const unverified = dropped > 0 || emitted > 0;
            outcome = unverified ? "dropped" : "no_answer";
            failure = unverified ? "unverified" : "no_answer";
          }
        }
        if (!usage) {
          Logger.warn("AI answers stream lacked usage; recording an estimate");
        }
        const billed = usage ?? streamedUsage();
        // A stream cut before its final usage is labelled as an error.
        await bill({ usage: billed, outcome: usage ? outcome : "error" });

        if (failure) {
          await finish([], { failed: failure });
          return;
        }
        await finish(verifier.released, {
          done: {
            usage: billed,
            timings: {
              retrievalMs,
              ...(firstBlockMs !== undefined ? { firstBlockMs } : {}),
              totalMs: Date.now() - startedAt,
            },
          },
        });
      } catch (error) {
        // A billed call must be metered even when the code after it throws.
        await freeSlot();
        if (sent && !recorded) {
          await bill({ usage: usage ?? streamedUsage(), outcome: "error" });
        }
        throw error;
      } finally {
        await freeSlot();
      }
    } catch (error) {
      Logger.warn("AI answers request failed", {
        error: toError(error).message,
      });
      stream.send("failed", { reason: "error", partial: emitted > 0 });
    } finally {
      stream.close();
      ctx.res.off("close", handleClose);
    }
  }
);

// Rates one answer. Stores the rating, its time and, with a "down" rating,
// an optional reason and the asker's redacted comment; never answer text. A
// plain "down" keeps an earlier report; "up" and "clear" remove it. The
// explicit team and asker WHERE below is the protection: row-level security
// only covers reads routed through the request transaction, and the
// production database role bypasses it.
router.post(
  "ai.feedback",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  validate(T.AIFeedbackSchema),
  async (ctx: APIContext<T.AIFeedbackReq>) => {
    const { user } = ctx.state.auth;
    const { usageId, rating, reason, comment } = ctx.input.body;

    assertAIAnswersAllowed(user);

    const feedback = rating === "up" ? 1 : rating === "down" ? -1 : null;
    const reported = reason !== undefined || comment !== undefined;
    // Redaction may lengthen the text; the column holds at most 500 characters.
    const redacted = comment
      ? [...redactSecrets(comment).text].slice(0, 500).join("").trim()
      : "";
    const [updated] = await AIAnswerUsage.update(
      {
        feedback,
        feedbackAt: feedback === null ? null : new Date(),
        ...(feedback !== -1 || reported
          ? {
              feedbackReason: reason ?? null,
              feedbackComment: redacted || null,
            }
          : {}),
      },
      { where: { id: usageId, teamId: user.teamId, userId: user.id } }
    );
    // Same answer for a missing row and someone else's row.
    if (updated === 0) {
      throw NotFoundError();
    }
    ctx.body = { success: true };
  }
);

export default router;
