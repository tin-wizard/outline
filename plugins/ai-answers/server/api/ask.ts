import Router from "koa-router";
import { safeSlugify } from "@shared/editor/lib/headingToSlug";
import { TeamPreference } from "@shared/types";
import { toError } from "@shared/utils/error";
import { AuthorizationError } from "@server/errors";
import Logger from "@server/logging/Logger";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import timeout from "@server/middlewares/timeout";
import validate from "@server/middlewares/validate";
import { Collection, Document } from "@server/models";
import type { AIAnswerOutcome } from "@server/models/AIAnswerUsage";
import type { User } from "@server/models";
import type { APIContext } from "@server/types";
import { releaseRequestTransaction } from "@server/storage/requestContext";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import { getClient } from "../anthropicClient";
import {
  BlockSplitter,
  blockToMarkdown,
  type Block,
  type BlockKind,
} from "../blocks";
import { ZERO_USAGE, type FinishReason, type Usage } from "../contract";
import {
  appendTurn,
  buildStandaloneQuery,
  createConversation,
  historyForModel,
  loadConversation,
  type Conversation,
} from "../conversation";
import env from "../env";
import { streamAnswer } from "../providers/anthropic";
import { redactSecrets } from "../redact";
import { retrieveSources, type AnswerSource } from "../retrieve";
import { estimateUsage, record, reserveModelCall } from "../usage";
import { AnswerVerifier, type AcceptedBlock } from "../verify";
import { clampDeadline, REQUEST_HEADROOM_MS } from "./answers";
import * as T from "./schema";

/** Why an answer ended without `done`. */
export type AskFailure =
  | "no_answer"
  | "unverified"
  | "budget"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "error";

/** A retrieved document as the client may show it. */
export interface AskSource {
  /** 1-based number, referenced by block citations. */
  n: number;
  documentId: string;
  title: string;
  url: string;
  collectionName?: string;
}

/** A citation of one released block. */
export interface AskCitation {
  /** The `n` of the cited source. */
  n: number;
  documentId: string;
  title: string;
  /** The document url, with the cited section's heading anchor when known. */
  url: string;
  quote?: string;
}

/** The events of the `ai.ask` stream and their `data` payloads. */
export interface AskEvents {
  conversation: { id: string };
  status: { phase: "searching" | "generating" | "notice"; message?: string };
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
    usage: Usage;
    timings: { retrievalMs: number; firstBlockMs?: number; totalMs: number };
  };
  failed: { reason: AskFailure; partial: boolean };
}

/** Comment line that keeps proxies and the socket idle timeout from closing a quiet stream. */
export const HEARTBEAT_MS = 10_000;

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
 * The sources as the client may show them: redacted titles, urls built from
 * the redacted title, and collection names only for collections the user is a
 * member of. Reads tenant data, so it runs before the transaction is released.
 */
async function presentSources(
  user: User,
  sources: AnswerSource[]
): Promise<AskSource[]> {
  const memberOf = new Set(await user.collectionIds());
  const ids = [...new Set(sources.map((s) => s.document.collectionId))].filter(
    (id): id is string => !!id && memberOf.has(id)
  );
  const names = new Map(
    ids.length > 0
      ? (
          await Collection.findAll({
            where: { id: ids, teamId: user.teamId },
            attributes: ["id", "name"],
          })
        ).map((c) => [c.id, redactSecrets(c.name).text])
      : []
  );
  return sources.map((s, i) => {
    const title = redactSecrets(s.document.title || "Untitled").text;
    const collectionName = s.document.collectionId
      ? names.get(s.document.collectionId)
      : undefined;
    return {
      n: i + 1,
      documentId: s.document.id,
      title,
      url: Document.getPath({ title, urlId: s.document.urlId }),
      ...(collectionName ? { collectionName } : {}),
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
    return [
      {
        n: source.n,
        documentId: source.documentId,
        title: source.title,
        url: c.heading ? `${source.url}#${safeSlugify(c.heading)}` : source.url,
        ...(quote ? { quote } : {}),
      },
    ];
  });
}

// Streams one AI turn as Server-Sent Events over POST (precedent:
// server/routes/mcp/index.ts). Same guards as documents.answerQuestion: the
// workspace preference, the role gate, abort on disconnect, a hard deadline,
// the request transaction released before the model call, and budget,
// unmetered flag and concurrency slot checked before any model call.
router.post(
  "ai.ask",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  validate(T.AIAskSchema),
  // After auth so unauthenticated and rate-limited requests keep the default window.
  timeout(clampDeadline(env.AI_ANSWERS_DEADLINE_MS) + REQUEST_HEADROOM_MS),
  async (ctx: APIContext<T.AIAskReq>) => {
    const { user } = ctx.state.auth;
    const { query, conversationId, collectionId, documentId } = ctx.input.body;

    if (!user.team.getPreference(TeamPreference.AIAnswers)) {
      throw AuthorizationError("AI answers are not enabled for this workspace");
    }
    // Owner decision D8: members and admins only.
    if (user.isGuest || user.isViewer) {
      throw AuthorizationError("AI answers are not available for your role");
    }

    const startedAt = Date.now();
    const clientGone = new AbortController();
    const handleClose = () => {
      if (!ctx.res.writableFinished) {
        clientGone.abort();
      }
    };
    // `res` close, not `req`: req emits "close" once the body is read.
    ctx.res.once("close", handleClose);
    const stream = openEventStream(ctx);
    let emitted = 0;

    try {
      // Conversation: an unknown, expired or foreign id starts a new one.
      let conversation: Conversation | null = null;
      let unavailable = false;
      if (conversationId) {
        const loaded = await loadConversation(user, conversationId);
        conversation = loaded.conversation;
        unavailable = loaded.unavailable;
      }
      if (!conversation && !unavailable) {
        conversation = await createConversation(user);
        unavailable = !conversation;
      }
      const id = conversation?.id ?? null;
      if (id) {
        stream.send("conversation", { id });
      }
      if (unavailable) {
        stream.send("status", {
          phase: "notice",
          message:
            "Conversation history is unavailable, so this answer does not use earlier questions.",
        });
      } else if (conversationId && id !== conversationId) {
        stream.send("status", {
          phase: "notice",
          message:
            "The earlier conversation has expired. A new one was started.",
        });
      }
      stream.send("status", { phase: "searching" });

      /** Stores the turn (only verified blocks; [] on failure), then ends the stream. */
      const finish = async (
        released: AcceptedBlock[],
        end: { failed: AskFailure } | { done: AskEvents["done"] }
      ) => {
        if (id && !clientGone.signal.aborted) {
          await appendTurn(user, id, { question: query, released });
        }
        if ("failed" in end) {
          stream.send("failed", { reason: end.failed, partial: emitted > 0 });
        } else {
          stream.send("done", end.done);
        }
      };

      // History and the standalone query re-check permissions (tenant reads).
      const history = await historyForModel(user, conversation);
      const standalone = await buildStandaloneQuery(user, conversation, query);
      const retrievalStartedAt = Date.now();
      let sources: AnswerSource[];
      try {
        // The standalone query only drives retrieval; the model gets `query`.
        sources = await retrieveSources(
          user,
          { query: standalone, collectionId, documentId },
          clientGone.signal
        );
      } catch (error) {
        if (clientGone.signal.aborted) {
          return;
        }
        throw error;
      }
      const retrievalMs = Date.now() - retrievalStartedAt;
      const presented = await presentSources(user, sources);
      stream.send("sources", presented);
      if (sources.length === 0) {
        await finish([], { failed: "no_answer" });
        return;
      }

      // Return the pinned connection before the slow model call (M1 task
      // 1.2). No tenant-data reads after this point.
      try {
        await releaseRequestTransaction();
      } catch (error) {
        Logger.warn("AI answers could not release the request transaction", {
          error: toError(error).message,
        });
        await finish([], { failed: "unavailable" });
        return;
      }

      // Nobody is waiting any more (the client left during retrieval).
      if (clientGone.signal.aborted) {
        return;
      }
      // CLIENT_MAX_RETRIES must stay 0: one billed call per request.
      const deadline = AbortSignal.timeout(
        clampDeadline(env.AI_ANSWERS_DEADLINE_MS)
      );
      const signal = AbortSignal.any([clientGone.signal, deadline]);
      const base = {
        teamId: user.teamId,
        userId: user.id,
        model: env.AI_ANSWERS_MODEL,
      };
      // Worst case for a call whose usage is unknown, history included.
      const estimate = estimateUsage(
        [query, ...history.flatMap((t) => [t.question, t.answer ?? ""])].join(
          "\n"
        ),
        sources
      );
      const aborted = (): AskFailure =>
        clientGone.signal.aborted ? "cancelled" : "timeout";

      const reservation = await reserveModelCall(user.teamId);
      if (!reservation.ok) {
        if (reservation.reason === "budget") {
          await record({
            ...base,
            usage: ZERO_USAGE,
            outcome: "budget_blocked",
          });
        }
        await finish([], {
          failed: reservation.reason === "budget" ? "budget" : "unavailable",
        });
        return;
      }

      const verifier = new AnswerVerifier(sources);
      const splitter = new BlockSplitter();
      let allText = "";
      let finishReason: FinishReason = "other";
      let usage: Usage | null = null;
      let dropped = 0;
      let firstBlockMs: number | undefined;
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

      const modelStartedAt = Date.now();
      try {
        // Aborted while reserving: no request was sent, so nothing was billed.
        if (signal.aborted) {
          await finish([], { failed: aborted() });
          return;
        }
        stream.send("status", { phase: "generating" });
        try {
          for await (const event of streamAnswer(getClient(), {
            question: query,
            sources,
            history,
            signal,
          })) {
            if (event.type === "text") {
              allText += event.text;
              release(splitter.push(event.text, event.citations));
            } else {
              finishReason = event.finishReason;
              usage = event.usage;
            }
          }
          release(splitter.flush());
        } catch (error) {
          Logger.warn("AI answers stream failed", {
            error: toError(error).message,
            aborted: signal.aborted,
          });
          // Billing for a failed or aborted call is unknown: assume the worst case.
          await record({
            ...base,
            usage: estimate,
            outcome: "error",
            droppedSegments: dropped,
            durationMs: Date.now() - modelStartedAt,
          });
          await finish([], { failed: signal.aborted ? aborted() : "error" });
          return;
        }
      } finally {
        await reservation.release();
      }

      const verdict = verifier.finish(finishReason, allText);
      let outcome: AIAnswerOutcome = "answered";
      let failure: AskFailure | undefined;
      if (!verdict.ok) {
        if (verdict.reason === "abstained") {
          outcome = "no_answer";
          failure = "no_answer";
        } else if (verdict.reason === "unfinished") {
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
      const billed = usage ?? estimate;
      await record({
        ...base,
        usage: billed,
        // A stream cut before its final usage is labelled as an error.
        outcome: usage ? outcome : "error",
        droppedSegments: dropped,
        durationMs: Date.now() - modelStartedAt,
      });

      if (failure) {
        await finish([], { failed: failure });
        return;
      }
      await finish(verifier.released, {
        done: {
          conversationId: id,
          usage: billed,
          timings: {
            retrievalMs,
            ...(firstBlockMs !== undefined ? { firstBlockMs } : {}),
            totalMs: Date.now() - startedAt,
          },
        },
      });
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

export default router;
