import { TeamPreference } from "@shared/types";
import { AIAnswerUsage, Team, type User } from "@server/models";
import {
  buildAdmin,
  buildGuestUser,
  buildUser,
  buildViewer,
} from "@server/test/factories";
import { getTestServer } from "@server/test/support";

const server = getTestServer();

async function enable(user: User) {
  const team = await Team.findByPk(user.teamId, { rejectOnEmpty: true });
  team.setPreference(TeamPreference.AIAnswers, true);
  await team.save();
  return user;
}

async function buildRow(user: User) {
  return AIAnswerUsage.create({
    teamId: user.teamId,
    userId: user.id,
    model: "claude-sonnet-5-5",
    inputTokens: 1,
    outputTokens: 1,
    costMicroUsd: "1",
    outcome: "answered",
    droppedSegments: 0,
    durationMs: 1,
  });
}

const rate = (user: User, usageId: string, rating: string) =>
  server.post("/api/ai.feedback", user, { body: { usageId, rating } });

const reload = (id: string) =>
  AIAnswerUsage.findByPk(id, { rejectOnEmpty: true });

describe("#ai.feedback", () => {
  it("requires authentication", async () => {
    const res = await server.post("/api/ai.feedback", {
      body: { usageId: crypto.randomUUID(), rating: "up" },
    });
    expect(res.status).toEqual(401);
  });

  it("sets, overwrites and clears a rating", async () => {
    const user = await enable(await buildUser());
    const row = await buildRow(user);
    expect((await reload(row.id)).feedback).toBeNull();

    let res = await rate(user, row.id, "up");
    expect(res.status).toEqual(200);
    expect((await res.json()).success).toEqual(true);
    let saved = await reload(row.id);
    expect(saved.feedback).toEqual(1);
    expect(saved.feedbackAt).toBeInstanceOf(Date);

    // Idempotent.
    expect((await rate(user, row.id, "up")).status).toEqual(200);
    expect((await reload(row.id)).feedback).toEqual(1);

    res = await rate(user, row.id, "down");
    expect(res.status).toEqual(200);
    saved = await reload(row.id);
    expect(saved.feedback).toEqual(-1);

    res = await rate(user, row.id, "clear");
    expect(res.status).toEqual(200);
    saved = await reload(row.id);
    expect(saved.feedback).toBeNull();
    expect(saved.feedbackAt).toBeNull();
  });

  it("does not let another user in the same team rate the row", async () => {
    const user = await enable(await buildUser());
    const other = await buildUser({ teamId: user.teamId });
    const row = await buildRow(user);
    const res = await rate(other, row.id, "up");
    expect(res.status).toEqual(404);
    expect((await reload(row.id)).feedback).toBeNull();
  });

  it("does not let another team rate the row", async () => {
    const user = await enable(await buildUser());
    const outsider = await enable(await buildUser());
    const row = await buildRow(user);
    const res = await rate(outsider, row.id, "down");
    expect(res.status).toEqual(404);
    expect((await reload(row.id)).feedback).toBeNull();
  });

  it("returns 404 for an unknown id", async () => {
    const user = await enable(await buildUser());
    const res = await rate(user, crypto.randomUUID(), "up");
    expect(res.status).toEqual(404);
  });

  it("returns 400 for an invalid rating or id", async () => {
    const user = await enable(await buildUser());
    const row = await buildRow(user);
    expect((await rate(user, row.id, "meh")).status).toEqual(400);
    expect((await rate(user, row.id, "1")).status).toEqual(400);
    expect((await rate(user, "nope", "up")).status).toEqual(400);
    expect((await reload(row.id)).feedback).toBeNull();
  });

  it.each([
    ["guest", buildGuestUser],
    ["viewer", buildViewer],
  ])("denies a %s with 403", async (_, build) => {
    const user = await enable(await build());
    const row = await buildRow(user);
    const res = await rate(user, row.id, "up");
    expect(res.status).toEqual(403);
    expect((await reload(row.id)).feedback).toBeNull();
  });

  it("returns 403 when the workspace preference is off", async () => {
    const user = await buildUser();
    const row = await buildRow(user);
    const res = await rate(user, row.id, "up");
    expect(res.status).toEqual(403);
    expect((await reload(row.id)).feedback).toBeNull();
  });

  describe("report reasons", () => {
    const report = (user: User, body: Record<string, unknown>) =>
      server.post("/api/ai.feedback", user, { body });
    // Synthetic, assembled at runtime so the repository holds no credential-like literal.
    const secret = "sk-ant-" + "api03-" + "c".repeat(30);

    it("stores a reason and a redacted, trimmed comment with a down rating", async () => {
      const user = await enable(await buildUser());
      const row = await buildRow(user);
      const res = await report(user, {
        usageId: row.id,
        rating: "down",
        reason: "outdated",
        comment: `  The policy changed in 2026, see ${secret}  `,
      });
      expect(res.status).toEqual(200);
      expect((await res.json()).success).toEqual(true);
      const saved = await reload(row.id);
      expect(saved.feedback).toEqual(-1);
      expect(saved.feedbackReason).toEqual("outdated");
      expect(saved.feedbackComment).not.toContain(secret);
      expect(saved.feedbackComment).toContain("[REDACTED:");
      expect(saved.feedbackComment?.startsWith("The policy changed")).toBe(
        true
      );
    });

    it("keeps an earlier report on a plain down, and clears it on up or clear", async () => {
      const user = await enable(await buildUser());
      const row = await buildRow(user);
      await report(user, {
        usageId: row.id,
        rating: "down",
        reason: "inaccurate",
        comment: "Wrong number",
      });
      expect((await rate(user, row.id, "down")).status).toEqual(200);
      let saved = await reload(row.id);
      expect(saved.feedbackReason).toEqual("inaccurate");
      expect(saved.feedbackComment).toEqual("Wrong number");

      // A new report replaces reason and comment together.
      await report(user, { usageId: row.id, rating: "down", reason: "other" });
      saved = await reload(row.id);
      expect(saved.feedbackReason).toEqual("other");
      expect(saved.feedbackComment).toBeNull();

      for (const rating of ["up", "clear"]) {
        await report(user, {
          usageId: row.id,
          rating: "down",
          reason: "incomplete",
          comment: "x",
        });
        expect((await rate(user, row.id, rating)).status).toEqual(200);
        saved = await reload(row.id);
        expect(saved.feedbackReason).toBeNull();
        expect(saved.feedbackComment).toBeNull();
      }
    });

    it("rejects an unknown reason, an oversized comment, and a report with up or clear", async () => {
      const user = await enable(await buildUser());
      const row = await buildRow(user);
      for (const body of [
        { rating: "down", reason: "rude" },
        { rating: "down", reason: "" },
        { rating: "down", comment: "a".repeat(501) },
        { rating: "down", comment: 42 },
        { rating: "up", reason: "inaccurate" },
        { rating: "clear", comment: "hi" },
      ]) {
        expect(
          (await report(user, { usageId: row.id, ...body })).status
        ).toEqual(400);
      }
      const saved = await reload(row.id);
      expect(saved.feedback).toBeNull();
      expect(saved.feedbackReason).toBeNull();
      expect(saved.feedbackComment).toBeNull();
    });

    it("accepts a 500-character comment and caps it at 500 after redaction", async () => {
      const user = await enable(await buildUser());
      const row = await buildRow(user);
      const comment = `${secret} ${"b".repeat(500 - secret.length - 1)}`;
      expect(comment).toHaveLength(500);
      const res = await report(user, {
        usageId: row.id,
        rating: "down",
        reason: "other",
        comment,
      });
      expect(res.status).toEqual(200);
      const saved = await reload(row.id);
      expect([...(saved.feedbackComment ?? "")].length).toBeLessThanOrEqual(
        500
      );
      expect(saved.feedbackComment).not.toContain(secret);
    });

    it("only changes the asker's own row and never returns comments", async () => {
      const user = await enable(await buildUser());
      const other = await buildUser({ teamId: user.teamId });
      const row = await buildRow(user);
      await report(user, {
        usageId: row.id,
        rating: "down",
        reason: "inaccurate",
        comment: "Mine",
      });
      const res = await report(other, {
        usageId: row.id,
        rating: "down",
        reason: "other",
        comment: "Theirs",
      });
      expect(res.status).toEqual(404);
      expect(await res.text()).not.toContain("Mine");
      const saved = await reload(row.id);
      expect(saved.feedbackReason).toEqual("inaccurate");
      expect(saved.feedbackComment).toEqual("Mine");
    });
  });

  it("lets an admin rate their own row", async () => {
    const admin = await enable(await buildAdmin());
    const row = await buildRow(admin);
    expect((await rate(admin, row.id, "up")).status).toEqual(200);
  });
});
