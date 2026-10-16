import { QueryTypes, Sequelize } from "sequelize";
import { vi } from "vitest";
import { AIAnswerUsage } from "@server/models";
import env from "@server/env";
import Redis from "@server/storage/redis";
import { buildTeam, buildUser } from "@server/test/factories";
import pluginEnv from "./env";
import {
  MAX_CONCURRENT_CALLS,
  acquireSlot,
  estimateUsage,
  getMonthlySpendMicroUsd,
  isOverBudget,
  monthlyBudgetMicroUsd,
  recordUsage,
  releaseSlot,
  reserveModelCall,
} from "./usage";

const usage = { inputTokens: 1000, outputTokens: 100 };

async function addRow(
  teamId: string,
  costMicroUsd: number,
  createdAt = new Date()
) {
  await AIAnswerUsage.create({
    teamId,
    userId: null,
    model: "claude-sonnet-5-5",
    inputTokens: 0,
    outputTokens: 0,
    costMicroUsd,
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

  it.each(["0", "-5", "abc", "", "NaN"])(
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
    const cost = await recordUsage({
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
    expect(row?.inputTokens).toEqual(1000);
    expect(row?.outputTokens).toEqual(100);
    expect(Number(row?.costMicroUsd)).toEqual(3000);
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

describe("row-level security", () => {
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
          await isolated.query(
            `SELECT set_config('app.team_id', :tenantId, true), set_config('app.rls_forced', 'on', true)`,
            { replacements: { tenantId }, transaction }
          );
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
    const reservation = await reserveModelCall(team.id);
    expect(reservation.ok).toEqual(true);
    if (reservation.ok) {
      await reservation.release();
    }
  });

  it("blocks over budget", async () => {
    const team = await buildTeam();
    await addRow(team.id, 25_000_000);
    expect(await reserveModelCall(team.id)).toEqual({
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
      expect(await reserveModelCall(team.id)).toEqual({
        ok: false,
        reason: "unavailable",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("fails closed when Redis throws", async () => {
    const team = await buildTeam();
    const spy = vi
      .spyOn(Redis.defaultClient, "eval")
      .mockRejectedValue(new Error("redis down"));
    try {
      expect(await reserveModelCall(team.id)).toEqual({
        ok: false,
        reason: "unavailable",
      });
    } finally {
      spy.mockRestore();
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
    expect(estimate.outputTokens).toEqual(1024);
    expect(estimate.inputTokens).toBeGreaterThan(100);
  });
});
