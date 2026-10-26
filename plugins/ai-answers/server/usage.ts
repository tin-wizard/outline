import { randomUUID } from "node:crypto";
import { Op } from "sequelize";
import Logger from "@server/logging/Logger";
import { AIAnswerUsage } from "@server/models";
import type { AIAnswerOutcome } from "@server/models/AIAnswerUsage";
import Redis from "@server/storage/redis";
import {
  MAX_OUTPUT_TOKENS,
  STRUCTURED_SYSTEM_PROMPT,
  type Usage,
} from "./contract";
import env from "./env";
import { costMicroUsd } from "./pricing";
import type { AnswerSource } from "./retrieve";

/** Simultaneous model calls allowed per workspace. */
export const MAX_CONCURRENT_CALLS = 3;

/** A slot not released within this time is reclaimed, so a crash cannot leak it. */
export const SLOT_TTL_MS = 60_000;

/** Redis calls slower than this count as Redis being down (fail closed). */
const REDIS_TIMEOUT_MS = 2000;

const DEFAULT_BUDGET_USD = 25;
const MAX_BUDGET_USD = 100_000;
let warnedInvalidBudget = false;

const DEFAULT_USER_DAILY_BUDGET_USD = 2;
let warnedInvalidUserBudget = false;

/** Shares of the monthly budget (percent) that log a warning once a month. */
export const BUDGET_ALERT_THRESHOLDS = [80, 100] as const;

/** Alert flags outlive the month they belong to, then expire. */
const ALERT_TTL_SECONDS = 35 * 24 * 3600;

/** How long a workspace stays blocked after a usage row could not be saved. */
const UNMETERED_TTL_SECONDS = 3600;

/** Why a model call was not made. */
export type BlockReason =
  | "budget"
  | "quota"
  | "concurrency"
  | "unavailable"
  | "unmetered";

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
  const raw = (env.AI_ANSWERS_MONTHLY_BUDGET_USD ?? "").trim();
  // An empty variable is the same as an unset one.
  if (raw === "") {
    return DEFAULT_BUDGET_USD * 1_000_000;
  }
  const usd = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || usd <= 0 || usd > MAX_BUDGET_USD) {
    if (!warnedInvalidBudget) {
      warnedInvalidBudget = true;
      Logger.warn("AI_ANSWERS_MONTHLY_BUDGET_USD is invalid; AI answers off");
    }
    return 0;
  }
  return Math.round(usd * 1_000_000);
}

/**
 * The daily cap per user in micro-USD (calendar day, UTC).
 *
 * @returns the cap; the $2 default when the setting is unset or invalid, and 0
 * (AI answers blocked for every user) when it is explicitly 0.
 */
export function userDailyBudgetMicroUsd(): number {
  const raw = (env.AI_ANSWERS_USER_DAILY_BUDGET_USD ?? "").trim();
  if (raw === "") {
    return DEFAULT_USER_DAILY_BUDGET_USD * 1_000_000;
  }
  const usd = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || usd > MAX_BUDGET_USD) {
    if (!warnedInvalidUserBudget) {
      warnedInvalidUserBudget = true;
      Logger.warn(
        "AI_ANSWERS_USER_DAILY_BUDGET_USD is invalid; using the default"
      );
    }
    return DEFAULT_USER_DAILY_BUDGET_USD * 1_000_000;
  }
  return Math.round(usd * 1_000_000);
}

/**
 * Records one request. Cost is derived from the model and token counts.
 *
 * @param entry what to record; never includes content.
 * @returns the cost recorded in micro-USD and the id of the created row.
 */
export async function recordUsage(
  entry: UsageEntry
): Promise<{ cost: number; id: string }> {
  const cost = costMicroUsd(entry.model, entry.usage);
  const row = await AIAnswerUsage.create({
    teamId: entry.teamId,
    userId: entry.userId,
    model: entry.model,
    inputTokens: entry.usage.inputTokens,
    outputTokens: entry.usage.outputTokens,
    costMicroUsd: String(cost),
    outcome: entry.outcome,
    droppedSegments: entry.droppedSegments ?? 0,
    durationMs: entry.durationMs ?? 0,
  });
  return { cost, id: row.id };
}

/**
 * Records usage without ever throwing. When the row cannot be saved, the
 * workspace is flagged unmetered so unrecorded spend cannot keep growing.
 *
 * @param entry what to record; never includes content.
 * @returns the id of the usage row, or null when it could not be saved.
 */
export async function record(entry: UsageEntry): Promise<string | null> {
  try {
    const { cost, id } = await recordUsage(entry);
    if (cost > 0) {
      // Fire and forget: the alert must never delay or fail the answer.
      void checkBudgetAlerts(entry.teamId);
    }
    return id;
  } catch {
    Logger.warn("AI answers usage could not be recorded", {
      outcome: entry.outcome,
      inputTokens: entry.usage.inputTokens,
      outputTokens: entry.usage.outputTokens,
    });
    // Unrecorded spend breaks the budget: stop calling the model for now.
    await markUnmetered(entry.teamId);
    return null;
  }
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
 * Total spend of one user in a workspace on the current calendar day (UTC).
 *
 * @param teamId the workspace.
 * @param userId the user.
 * @param now the reference time, for tests.
 * @returns micro-USD spent.
 * @throws if the sum cannot be read; callers must fail closed.
 */
export async function getUserDailySpendMicroUsd(
  teamId: string,
  userId: string,
  now: Date = new Date()
): Promise<number> {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  // Served by the (teamId, createdAt) index; userId filters one day's rows.
  const total = Number(
    (await AIAnswerUsage.sum("costMicroUsd", {
      where: { teamId, userId, createdAt: { [Op.gte]: start, [Op.lt]: end } },
    })) ?? 0
  );
  if (!Number.isFinite(total)) {
    throw new Error("Unreadable AI answers spend");
  }
  return total;
}

/**
 * Whether a user has used up their daily allowance.
 *
 * @param teamId the workspace.
 * @param userId the user.
 * @param now the reference time, for tests.
 * @returns true at or above the cap, and always when the cap is 0.
 */
export async function isOverUserQuota(
  teamId: string,
  userId: string,
  now: Date = new Date()
): Promise<boolean> {
  const budget = userDailyBudgetMicroUsd();
  if (budget <= 0) {
    return true;
  }
  return (await getUserDailySpendMicroUsd(teamId, userId, now)) >= budget;
}

/**
 * Logs a warning the first time in a UTC month that a workspace's spend
 * reaches each alert threshold of its monthly budget. A Redis flag per
 * workspace, month and threshold keeps it to one warning. Never throws.
 *
 * @param teamId the workspace.
 * @param now the reference time, for tests.
 */
export async function checkBudgetAlerts(
  teamId: string,
  now: Date = new Date()
): Promise<void> {
  try {
    const budget = monthlyBudgetMicroUsd();
    if (budget <= 0) {
      return;
    }
    const spend = await getMonthlySpendMicroUsd(teamId, now);
    const month = now.toISOString().slice(0, 7);
    for (const threshold of BUDGET_ALERT_THRESHOLDS) {
      if (spend * 100 < budget * threshold) {
        continue;
      }
      const first = await withTimeout(
        Redis.defaultClient.set(
          `ai-answers:alert:${teamId}:${month}:${threshold}`,
          "1",
          "EX",
          ALERT_TTL_SECONDS,
          "NX"
        )
      );
      if (first === "OK") {
        Logger.warn("AI answers workspace budget threshold reached", {
          teamId,
          threshold,
          spendUsd: spend / 1_000_000,
          budgetUsd: budget / 1_000_000,
        });
      }
    }
  } catch {
    Logger.warn("AI answers budget alert check failed", { teamId });
  }
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
 * Blocks a workspace's model calls for an hour. Used when a call's usage could
 * not be recorded, so spend that is not in the books cannot keep growing.
 *
 * @param teamId the workspace.
 */
export async function markUnmetered(teamId: string): Promise<void> {
  try {
    await withTimeout(
      Redis.defaultClient.set(
        unmeteredKey(teamId),
        "1",
        "EX",
        UNMETERED_TTL_SECONDS
      )
    );
  } catch {
    Logger.warn("AI answers could not flag an unmetered workspace");
  }
}

/**
 * Decides whether a model call may be made and takes a concurrency slot.
 * Any failure to find out (database or Redis) refuses the call.
 *
 * @param teamId the workspace.
 * @param userId the asking user, held to their daily allowance.
 * @returns a release function when allowed, otherwise the reason it is not.
 */
export async function reserveModelCall(
  teamId: string,
  userId: string
): Promise<Reservation> {
  // Budget and slot are not taken atomically; any overshoot is bounded by the
  // concurrency cap (3 calls in flight).
  try {
    if (await withTimeout(Redis.defaultClient.exists(unmeteredKey(teamId)))) {
      Logger.warn("AI answers refused: workspace is flagged unmetered", {
        teamId,
      });
      return { ok: false, reason: "unmetered" };
    }
    if (await isOverBudget(teamId)) {
      Logger.warn("AI answers refused: monthly budget reached", { teamId });
      return { ok: false, reason: "budget" };
    }
    if (await isOverUserQuota(teamId, userId)) {
      Logger.warn("AI answers refused: user daily limit reached", {
        teamId,
        userId,
      });
      return { ok: false, reason: "quota" };
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
    Logger.warn("AI answers limiter unavailable; refusing model call", {
      teamId,
    });
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
    STRUCTURED_SYSTEM_PROMPT.length +
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

function unmeteredKey(teamId: string): string {
  return `ai-answers:unmetered:${teamId}`;
}

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
