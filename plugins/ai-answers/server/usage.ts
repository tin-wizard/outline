import { randomUUID } from "node:crypto";
import { Op } from "sequelize";
import Logger from "@server/logging/Logger";
import { AIAnswerUsage } from "@server/models";
import type { AIAnswerOutcome } from "@server/models/AIAnswerUsage";
import Redis from "@server/storage/redis";
import { MAX_OUTPUT_TOKENS, SYSTEM_PROMPT, type Usage } from "./contract";
import env from "./env";
import { costMicroUsd } from "./pricing";
import type { AnswerSource } from "./retrieve";

/** Simultaneous model calls allowed per workspace. */
export const MAX_CONCURRENT_CALLS = 3;

/** A slot not released within this time is reclaimed, so a crash cannot leak it. */
export const SLOT_TTL_MS = 60_000;

/** Redis calls slower than this count as Redis being down (fail closed). */
const REDIS_TIMEOUT_MS = 2000;

/** Why a model call was not made. */
export type BlockReason = "budget" | "concurrency" | "unavailable";

/** The result of asking permission to call the model. */
export type Reservation =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; reason: BlockReason };

/** The fields recorded for one request. */
export interface UsageEntry {
  teamId: string;
  userId: string | null;
  model: string;
  usage: Usage;
  outcome: AIAnswerOutcome;
  droppedSegments?: number;
  durationMs?: number;
}

/**
 * The monthly cap per workspace in micro-USD.
 *
 * @returns the cap; 0 (AI answers disabled) when the setting is 0 or invalid.
 */
export function monthlyBudgetMicroUsd(): number {
  const usd = Number(env.AI_ANSWERS_MONTHLY_BUDGET_USD);
  return Number.isFinite(usd) && usd > 0 ? Math.round(usd * 1_000_000) : 0;
}

/**
 * Records one request. Cost is derived from the model and token counts.
 *
 * @param entry what to record; never includes content.
 * @returns the cost recorded in micro-USD.
 */
export async function recordUsage(entry: UsageEntry): Promise<number> {
  const cost = costMicroUsd(entry.model, entry.usage);
  await AIAnswerUsage.create({
    teamId: entry.teamId,
    userId: entry.userId,
    model: entry.model,
    inputTokens: entry.usage.inputTokens,
    outputTokens: entry.usage.outputTokens,
    costMicroUsd: cost,
    outcome: entry.outcome,
    droppedSegments: entry.droppedSegments ?? 0,
    durationMs: entry.durationMs ?? 0,
  });
  return cost;
}

/**
 * Total spend of a workspace in the current calendar month (UTC).
 *
 * @param teamId the workspace.
 * @param now the reference time, for tests.
 * @returns micro-USD spent.
 * @throws if the sum cannot be read; callers must fail closed.
 */
export async function getMonthlySpendMicroUsd(
  teamId: string,
  now: Date = new Date()
): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  );
  const total = Number(
    (await AIAnswerUsage.sum("costMicroUsd", {
      where: { teamId, createdAt: { [Op.gte]: start, [Op.lt]: end } },
    })) ?? 0
  );
  if (!Number.isFinite(total)) {
    throw new Error("Unreadable AI answers spend");
  }
  return total;
}

/**
 * Whether a workspace has used up its monthly budget.
 *
 * @param teamId the workspace.
 * @param now the reference time, for tests.
 * @returns true at or above the cap, and always when the cap is 0.
 */
export async function isOverBudget(
  teamId: string,
  now: Date = new Date()
): Promise<boolean> {
  const budget = monthlyBudgetMicroUsd();
  if (budget <= 0) {
    return true;
  }
  return (await getMonthlySpendMicroUsd(teamId, now)) >= budget;
}

/**
 * Takes one of the workspace's concurrent-call slots.
 *
 * @param teamId the workspace.
 * @returns a token to release the slot, or null when all slots are taken.
 * @throws if Redis is unavailable; callers must fail closed.
 */
export async function acquireSlot(teamId: string): Promise<string | null> {
  const token = randomUUID();
  const acquired = await withTimeout(
    Redis.defaultClient.eval(
      ACQUIRE_SCRIPT,
      1,
      slotKey(teamId),
      Date.now(),
      SLOT_TTL_MS,
      MAX_CONCURRENT_CALLS,
      token
    )
  );
  return acquired === 1 ? token : null;
}

/**
 * Frees a slot taken with `acquireSlot`.
 *
 * @param teamId the workspace.
 * @param token the token returned by `acquireSlot`.
 * @throws if Redis is unavailable; the slot then expires on its own.
 */
export async function releaseSlot(
  teamId: string,
  token: string
): Promise<void> {
  await withTimeout(Redis.defaultClient.zrem(slotKey(teamId), token));
}

/**
 * Decides whether a model call may be made and takes a concurrency slot.
 * Any failure to find out (database or Redis) refuses the call.
 *
 * @param teamId the workspace.
 * @returns a release function when allowed, otherwise the reason it is not.
 */
export async function reserveModelCall(teamId: string): Promise<Reservation> {
  try {
    if (await isOverBudget(teamId)) {
      return { ok: false, reason: "budget" };
    }
    const token = await acquireSlot(teamId);
    if (!token) {
      return { ok: false, reason: "concurrency" };
    }
    return {
      ok: true,
      release: async () => {
        try {
          await releaseSlot(teamId, token);
        } catch {
          Logger.warn("AI answers slot release failed; it will expire");
        }
      },
    };
  } catch {
    Logger.warn("AI answers limiter unavailable; refusing model call");
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Worst-case usage for a call whose real usage is unknown: the full output
 * ceiling plus a deliberately high input estimate (one token per 3 characters).
 *
 * @param question the user's question.
 * @param sources the sources sent to the model.
 * @returns the estimated token counts.
 */
export function estimateUsage(
  question: string,
  sources: AnswerSource[]
): Usage {
  const chars =
    SYSTEM_PROMPT.length +
    question.length +
    sources.reduce(
      (sum, s) =>
        sum +
        (s.document.title?.length ?? 0) +
        s.sections.reduce((n, section) => n + section.length, 0),
      0
    );
  return {
    inputTokens: Math.ceil(chars / 3),
    outputTokens: MAX_OUTPUT_TOKENS,
  };
}

const ACQUIRE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]), ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

function slotKey(teamId: string): string {
  return `ai-answers:slots:${teamId}`;
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Redis timeout")),
      REDIS_TIMEOUT_MS
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
