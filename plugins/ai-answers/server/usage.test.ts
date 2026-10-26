import { randomUUID } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";
import type { Transaction } from "sequelize";
import { vi, type MockInstance } from "vitest";
import Logger from "@server/logging/Logger";
import { AIAnswerUsage } from "@server/models";
import env from "@server/env";
import { sequelize } from "@server/storage/database";
import Redis from "@server/storage/redis";
import { buildTeam, buildUser } from "@server/test/factories";
import { CLIENT_MAX_RETRIES, CLIENT_TIMEOUT_MS } from "./anthropicClient";
import { MAX_OUTPUT_TOKENS, STRUCTURED_SYSTEM_PROMPT } from "./contract";
import pluginEnv from "./env";
import {
  MAX_CONCURRENT_CALLS,
  SLOT_TTL_MS,
  markUnmetered,
  acquireSlot,
  checkBudgetAlerts,
  estimateUsage,
  getUserDailySpendMicroUsd,
  getMonthlySpendMicroUsd,
  isOverBudget,
  monthlyBudgetMicroUsd,
  record,
  recordUsage,
  releaseSlot,
  reserveModelCall,
  userDailyBudgetMicroUsd,
} from "./usage";

const usage = { inputTokens: 1000, outputTokens: 100 };

async function addRow(
  teamId: string,
  costMicroUsd: number,
  createdAt = new Date(),
  userId: string | null = null
) {
  await AIAnswerUsage.create({
    teamId,
    userId,
    model: "claude-sonnet-5-5",
    inputTokens: 0,
    outputTokens: 0,
    costMicroUsd: String(costMicroUsd),
    outcome: "answered",
    droppedSegments: 0,
    durationMs: 0,
    createdAt,
  });
}

describe("monthlyBudgetMicroUsd", () => {
  const original = pluginEnv.AI_ANSWERS_MONTHLY_BUDGET_USD;
  afterEach(() => {
    pluginEnv.AI_ANSWERS_MONTHLY_BUDGET_USD = original;
  });

  it("defaults to $25", () => {
    expect(original).toEqual("25");
    expect(monthlyBudgetMicroUsd()).toEqual(25_000_000);
  });

  it("treats an empty or blank value as unset (default $25)", () => {
    pluginEnv.AI_ANSWERS_MONTHLY_BUDGET_USD = "";
    expect(monthlyBudgetMicroUsd()).toEqual(25_000_000);
    pluginEnv.AI_ANSWERS_MONTHLY_BUDGET_USD = "  ";
    expect(monthlyBudgetMicroUsd()).toEqual(25_000_000);
  });

  it("accepts decimals and surrounding whitespace", () => {
    pluginEnv.AI_ANSWERS_MONTHLY_BUDGET_USD = " 12.5 ";
    expect(monthlyBudgetMicroUsd()).toEqual(12_500_000);
  });

  it.each(["0", "-5", "abc", "NaN", "1e3", "Infinity", "0x10", "100001", "5."])(
    "disables AI answers for %p",
    (value) => {
      pluginEnv.AI_ANSWERS_MONTHLY_BUDGET_USD = value;
      expect(monthlyBudgetMicroUsd()).toEqual(0);
    }
  );
});

describe("recordUsage and spend", () => {
  it("records tokens and cost without content", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const { cost, id } = await recordUsage({
      teamId: team.id,
      userId: user.id,
      model: "claude-sonnet-5-5",
      usage,
      outcome: "answered",
      droppedSegments: 1,
      durationMs: 42,
    });
    expect(cost).toEqual(3000);
    const row = await AIAnswerUsage.findOne({ where: { teamId: team.id } });
    expect(row?.id).toEqual(id);
    expect(row?.inputTokens).toEqual(1000);
    expect(row?.outputTokens).toEqual(100);
    expect(row?.costMicroUsd).toEqual("3000");
    expect(row?.outcome).toEqual("answered");
    expect(row?.droppedSegments).toEqual(1);
  });

  it("sums only this team and this UTC month", async () => {
    const a = await buildTeam();
    const b = await buildTeam();
    const now = new Date(Date.UTC(2026, 9, 16, 12));
    await addRow(a.id, 1000, new Date(Date.UTC(2026, 9, 1, 0, 0, 0)));
    await addRow(a.id, 2000, new Date(Date.UTC(2026, 9, 31, 23, 59, 59)));
    await addRow(a.id, 5000, new Date(Date.UTC(2026, 8, 30, 23, 59, 59)));
    await addRow(a.id, 7000, new Date(Date.UTC(2026, 10, 1, 0, 0, 0)));
    await addRow(b.id, 9000, now);

    expect(await getMonthlySpendMicroUsd(a.id, now)).toEqual(3000);
    expect(await getMonthlySpendMicroUsd(b.id, now)).toEqual(9000);
  });

  it("is zero with no rows", async () => {
    const team = await buildTeam();
    expect(await getMonthlySpendMicroUsd(team.id)).toEqual(0);
  });

  it("is over budget at the cap but not below it", async () => {
    const team = await buildTeam();
    await addRow(team.id, 24_999_999);
    expect(await isOverBudget(team.id)).toEqual(false);
    await addRow(team.id, 1);
    expect(await isOverBudget(team.id)).toEqual(true);
  });
});

describe("slot lifetime", () => {
  it("outlasts the client timeout across all attempts", () => {
    expect(SLOT_TTL_MS).toBeGreaterThan(
      CLIENT_TIMEOUT_MS * (CLIENT_MAX_RETRIES + 1)
    );
  });
});

describe("row-level security", () => {
  // CI connects as a superuser, which bypasses RLS even with FORCE. In that
  // case the queries below drop to a plain role so the policy is exercised.
  const rlsRole = "outline_ai_answers_rls_test";
  let bypassesRls = false;

  beforeAll(async () => {
    const [row] = await sequelize.query<{ bypass: boolean }>(
      `SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
      { type: QueryTypes.SELECT }
    );
    bypassesRls = row.bypass;
    if (!bypassesRls) {
      return;
    }
    await sequelize.query(
      `DO $$ BEGIN
         CREATE ROLE ${rlsRole} NOLOGIN NOSUPERUSER NOBYPASSRLS;
       EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
       END $$`
    );
    await sequelize.query(
      `GRANT SELECT, INSERT ON ai_answer_usages TO ${rlsRole}`
    );
  });

  /** Sets the tenant for the transaction, as the request transaction does. */
  const enterTenant = async (
    isolated: Sequelize,
    tenantId: string,
    transaction: Transaction
  ) => {
    await isolated.query(
      `SELECT set_config('app.team_id', :tenantId, true), set_config('app.rls_forced', 'on', true)`,
      { replacements: { tenantId }, transaction }
    );
    if (bypassesRls) {
      await isolated.query(`SET LOCAL ROLE ${rlsRole}`, { transaction });
    }
  };

  it("hides one team's usage from another team's tenant context", async () => {
    const a = await buildTeam();
    const b = await buildTeam();
    await addRow(a.id, 1234);

    // A dedicated connection: SET LOCAL leaves "" behind on pooled ones.
    const countAs = async (tenantId: string) => {
      const isolated = new Sequelize(env.DATABASE_URL as string, {
        logging: false,
      });
      try {
        return await isolated.transaction(async (transaction) => {
          await enterTenant(isolated, tenantId, transaction);
          const [row] = await isolated.query<{ count: string }>(
            `SELECT count(*) FROM ai_answer_usages WHERE "teamId" = :teamId`,
            {
              replacements: { teamId: a.id },
              type: QueryTypes.SELECT,
              transaction,
            }
          );
          return Number(row.count);
        });
      } finally {
        await isolated.close();
      }
    };

    // WITH CHECK: a tenant cannot write another tenant's rows.
    const insertAs = async (tenantId: string, rowTeamId: string) => {
      const isolated = new Sequelize(env.DATABASE_URL as string, {
        logging: false,
      });
      try {
        await isolated.transaction(async (transaction) => {
          await enterTenant(isolated, tenantId, transaction);
          await isolated.query(
            `INSERT INTO ai_answer_usages (id, "teamId", model, "inputTokens", "outputTokens", "costMicroUsd", outcome, "createdAt")
             VALUES (gen_random_uuid(), :rowTeamId, 'm', 0, 0, 0, 'answered', now())`,
            { replacements: { rowTeamId }, transaction }
          );
        });
      } finally {
        await isolated.close();
      }
    };
    await expect(insertAs(b.id, a.id)).rejects.toThrow(/row-level security/);
    await expect(insertAs(b.id, b.id)).resolves.toBeUndefined();

    expect(await countAs(b.id)).toEqual(0);
    expect(await countAs(a.id)).toEqual(1);
  });
});

describe("concurrency slots", () => {
  it("allows three at once, blocks the fourth, and frees on release", async () => {
    const team = await buildTeam();
    const tokens: string[] = [];
    for (let i = 0; i < MAX_CONCURRENT_CALLS; i++) {
      const token = await acquireSlot(team.id);
      expect(token).not.toBeNull();
      tokens.push(token as string);
    }
    expect(await acquireSlot(team.id)).toBeNull();

    await releaseSlot(team.id, tokens[0]);
    const again = await acquireSlot(team.id);
    expect(again).not.toBeNull();
    expect(await acquireSlot(team.id)).toBeNull();

    for (const token of [...tokens.slice(1), again as string]) {
      await releaseSlot(team.id, token);
    }
  });

  it("is per workspace", async () => {
    const a = await buildTeam();
    const b = await buildTeam();
    const held: string[] = [];
    for (let i = 0; i < MAX_CONCURRENT_CALLS; i++) {
      held.push((await acquireSlot(a.id)) as string);
    }
    const other = await acquireSlot(b.id);
    expect(other).not.toBeNull();
    await releaseSlot(b.id, other as string);
    for (const token of held) {
      await releaseSlot(a.id, token);
    }
  });

  it("reclaims a slot whose holder never released it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const team = await buildTeam();
      for (let i = 0; i < MAX_CONCURRENT_CALLS; i++) {
        await acquireSlot(team.id);
      }
      expect(await acquireSlot(team.id)).toBeNull();
      vi.setSystemTime(Date.now() + 61_000);
      const token = await acquireSlot(team.id);
      expect(token).not.toBeNull();
      await Redis.defaultClient.del(`ai-answers:slots:${team.id}`);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reserveModelCall", () => {
  it("allows a call under budget and releases its slot", async () => {
    const team = await buildTeam();
    const reservation = await reserveModelCall(team.id, randomUUID());
    expect(reservation.ok).toEqual(true);
    if (reservation.ok) {
      await reservation.release();
    }
  });

  it("blocks over budget", async () => {
    const team = await buildTeam();
    await addRow(team.id, 25_000_000);
    expect(await reserveModelCall(team.id, randomUUID())).toEqual({
      ok: false,
      reason: "budget",
    });
  });

  it("fails closed when the spend query throws", async () => {
    const team = await buildTeam();
    const spy = vi
      .spyOn(AIAnswerUsage, "sum")
      .mockRejectedValue(new Error("db down"));
    try {
      expect(await reserveModelCall(team.id, randomUUID())).toEqual({
        ok: false,
        reason: "unavailable",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("blocks while the workspace is flagged unmetered", async () => {
    const team = await buildTeam();
    await markUnmetered(team.id);
    try {
      expect(await reserveModelCall(team.id, randomUUID())).toEqual({
        ok: false,
        reason: "unmetered",
      });
    } finally {
      await Redis.defaultClient.del(`ai-answers:unmetered:${team.id}`);
    }
  });

  it("fails closed when Redis throws", async () => {
    const team = await buildTeam();
    const spy = vi
      .spyOn(Redis.defaultClient, "eval")
      .mockRejectedValue(new Error("redis down"));
    try {
      expect(await reserveModelCall(team.id, randomUUID())).toEqual({
        ok: false,
        reason: "unavailable",
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("userDailyBudgetMicroUsd", () => {
  const original = pluginEnv.AI_ANSWERS_USER_DAILY_BUDGET_USD;
  afterEach(() => {
    pluginEnv.AI_ANSWERS_USER_DAILY_BUDGET_USD = original;
  });

  it("defaults to $2 when unset or blank", () => {
    pluginEnv.AI_ANSWERS_USER_DAILY_BUDGET_USD = undefined;
    expect(userDailyBudgetMicroUsd()).toEqual(2_000_000);
    pluginEnv.AI_ANSWERS_USER_DAILY_BUDGET_USD = "  ";
    expect(userDailyBudgetMicroUsd()).toEqual(2_000_000);
  });

  it("accepts decimals and surrounding whitespace", () => {
    pluginEnv.AI_ANSWERS_USER_DAILY_BUDGET_USD = " 0.5 ";
    expect(userDailyBudgetMicroUsd()).toEqual(500_000);
  });

  it("treats an explicit 0 as no AI for users", () => {
    pluginEnv.AI_ANSWERS_USER_DAILY_BUDGET_USD = "0";
    expect(userDailyBudgetMicroUsd()).toEqual(0);
  });

  it.each(["-5", "abc", "NaN", "1e3", "Infinity", "0x10", "100001", "5."])(
    "uses the default for invalid %p",
    (value) => {
      pluginEnv.AI_ANSWERS_USER_DAILY_BUDGET_USD = value;
      expect(userDailyBudgetMicroUsd()).toEqual(2_000_000);
    }
  );
});

describe("per-user daily quota", () => {
  const original = pluginEnv.AI_ANSWERS_USER_DAILY_BUDGET_USD;
  afterEach(() => {
    pluginEnv.AI_ANSWERS_USER_DAILY_BUDGET_USD = original;
  });

  it("sums only this user, this team and this UTC day", async () => {
    const team = await buildTeam();
    const other = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const peer = await buildUser({ teamId: team.id });
    const now = new Date(Date.UTC(2026, 9, 16, 12));
    await addRow(team.id, 100, new Date(Date.UTC(2026, 9, 16, 0)), user.id);
    await addRow(
      team.id,
      200,
      new Date(Date.UTC(2026, 9, 16, 23, 59)),
      user.id
    );
    await addRow(
      team.id,
      400,
      new Date(Date.UTC(2026, 9, 15, 23, 59)),
      user.id
    );
    await addRow(team.id, 800, new Date(Date.UTC(2026, 9, 17, 0)), user.id);
    await addRow(team.id, 1600, now, peer.id);
    await addRow(other.id, 3200, now, user.id);
    expect(await getUserDailySpendMicroUsd(team.id, user.id, now)).toEqual(300);
  });

  it("blocks a user at their daily cap but not their teammates", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const peer = await buildUser({ teamId: team.id });
    await addRow(team.id, 2_000_000, new Date(), user.id);
    expect(await reserveModelCall(team.id, user.id)).toEqual({
      ok: false,
      reason: "quota",
    });
    const allowed = await reserveModelCall(team.id, peer.id);
    expect(allowed.ok).toEqual(true);
    if (allowed.ok) {
      await allowed.release();
    }
  });

  it("allows a user just under the cap", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    await addRow(team.id, 1_999_999, new Date(), user.id);
    const reservation = await reserveModelCall(team.id, user.id);
    expect(reservation.ok).toEqual(true);
    if (reservation.ok) {
      await reservation.release();
    }
  });

  it("blocks every user when the cap is 0", async () => {
    pluginEnv.AI_ANSWERS_USER_DAILY_BUDGET_USD = "0";
    const team = await buildTeam();
    expect(await reserveModelCall(team.id, randomUUID())).toEqual({
      ok: false,
      reason: "quota",
    });
  });

  it("checks the workspace budget before the user quota", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    await addRow(team.id, 25_000_000, new Date(), user.id);
    expect(await reserveModelCall(team.id, user.id)).toEqual({
      ok: false,
      reason: "budget",
    });
  });

  it("fails closed when the user spend query throws", async () => {
    const team = await buildTeam();
    const spy = vi
      .spyOn(AIAnswerUsage, "sum")
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error("db down"));
    try {
      expect(await reserveModelCall(team.id, randomUUID())).toEqual({
        ok: false,
        reason: "unavailable",
      });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("checkBudgetAlerts", () => {
  const now = new Date(Date.UTC(2026, 9, 16, 12));
  const alerts = (spy: MockInstance<typeof Logger.warn>) =>
    spy.mock.calls.filter(
      ([message]) => message === "AI answers workspace budget threshold reached"
    );

  it("warns once per threshold per month, with numbers only", async () => {
    const team = await buildTeam();
    const warn = vi.spyOn(Logger, "warn");
    try {
      await addRow(team.id, 19_000_000, now);
      await checkBudgetAlerts(team.id, now);
      expect(alerts(warn)).toHaveLength(0);

      await addRow(team.id, 1_000_000, now);
      await checkBudgetAlerts(team.id, now);
      await checkBudgetAlerts(team.id, now);
      expect(alerts(warn)).toEqual([
        [
          "AI answers workspace budget threshold reached",
          { teamId: team.id, threshold: 80, spendUsd: 20, budgetUsd: 25 },
        ],
      ]);

      await addRow(team.id, 5_000_000, now);
      await checkBudgetAlerts(team.id, now);
      await checkBudgetAlerts(team.id, now);
      expect(alerts(warn)).toHaveLength(2);
      expect(alerts(warn)[1][1]).toEqual({
        teamId: team.id,
        threshold: 100,
        spendUsd: 25,
        budgetUsd: 25,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("warns for both thresholds when one jump crosses both", async () => {
    const team = await buildTeam();
    const warn = vi.spyOn(Logger, "warn");
    try {
      await addRow(team.id, 30_000_000, now);
      await checkBudgetAlerts(team.id, now);
      expect(alerts(warn).map(([, extra]) => extra?.threshold)).toEqual([
        80, 100,
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns again in a new month", async () => {
    const team = await buildTeam();
    const next = new Date(Date.UTC(2026, 10, 2, 12));
    const warn = vi.spyOn(Logger, "warn");
    try {
      await addRow(team.id, 21_000_000, now);
      await checkBudgetAlerts(team.id, now);
      await checkBudgetAlerts(team.id, next);
      expect(alerts(warn)).toHaveLength(1);
      await addRow(team.id, 21_000_000, next);
      await checkBudgetAlerts(team.id, next);
      expect(alerts(warn)).toHaveLength(2);
      expect(
        await Redis.defaultClient.exists(
          `ai-answers:alert:${team.id}:2026-11:80`
        )
      ).toEqual(1);
      expect(
        await Redis.defaultClient.ttl(`ai-answers:alert:${team.id}:2026-11:80`)
      ).toBeGreaterThan(34 * 24 * 3600);
    } finally {
      warn.mockRestore();
    }
  });

  it("never throws and logs once when Redis fails", async () => {
    const team = await buildTeam();
    await addRow(team.id, 30_000_000, now);
    const warn = vi.spyOn(Logger, "warn");
    const set = vi
      .spyOn(Redis.defaultClient, "set")
      .mockRejectedValue(new Error("redis down"));
    try {
      await expect(checkBudgetAlerts(team.id, now)).resolves.toBeUndefined();
      expect(alerts(warn)).toHaveLength(0);
      expect(
        warn.mock.calls.filter(
          ([message]) => message === "AI answers budget alert check failed"
        )
      ).toHaveLength(1);
    } finally {
      set.mockRestore();
      warn.mockRestore();
    }
  });

  it("never throws when the spend query fails", async () => {
    const team = await buildTeam();
    const sum = vi
      .spyOn(AIAnswerUsage, "sum")
      .mockRejectedValue(new Error("db down"));
    try {
      await expect(checkBudgetAlerts(team.id, now)).resolves.toBeUndefined();
    } finally {
      sum.mockRestore();
    }
  });

  it("runs after a billed request is recorded", async () => {
    const team = await buildTeam();
    await addRow(team.id, 19_999_000);
    const warn = vi.spyOn(Logger, "warn");
    try {
      await record({
        teamId: team.id,
        userId: null,
        model: "claude-sonnet-5-5",
        usage,
        outcome: "answered",
      });
      await vi.waitFor(() => expect(alerts(warn)).toHaveLength(1));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("estimateUsage", () => {
  it("assumes the full output ceiling and a high input estimate", () => {
    const estimate = estimateUsage("question", [
      {
        document: { title: "Title" },
        sections: ["a".repeat(300)],
      } as never,
    ]);
    expect(estimate.outputTokens).toEqual(MAX_OUTPUT_TOKENS);
    expect(estimate.inputTokens).toBeGreaterThan(100);
  });

  it("counts the longer structured prompt", () => {
    expect(estimateUsage("", []).inputTokens).toBeGreaterThanOrEqual(
      STRUCTURED_SYSTEM_PROMPT.length / 3
    );
  });
});
