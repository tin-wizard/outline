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

  it("lets an admin rate their own row", async () => {
    const admin = await enable(await buildAdmin());
    const row = await buildRow(admin);
    expect((await rate(admin, row.id, "up")).status).toEqual(200);
  });
});
