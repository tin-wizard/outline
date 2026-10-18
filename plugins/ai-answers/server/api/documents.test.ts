import { TeamPreference } from "@shared/types";
import { Team, type User } from "@server/models";
import {
  buildCollection,
  buildDocument,
  buildDraftDocument,
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

const list = (user: User, body: Record<string, unknown> = {}) =>
  server.post("/api/ai.documents", user, { body });

describe("#ai.documents", () => {
  it("requires authentication", async () => {
    const res = await server.post("/api/ai.documents", { body: {} });
    expect(res.status).toEqual(401);
  });

  it("returns 403 when AI answers are off, and for guests and viewers", async () => {
    expect((await list(await buildUser())).status).toEqual(403);
    for (const build of [buildGuestUser, buildViewer]) {
      expect((await list(await enable(await build()))).status).toEqual(403);
    }
  });

  it("rejects an oversized limit or query", async () => {
    const user = await enable(await buildUser());
    expect((await list(user, { limit: 21 })).status).toEqual(400);
    expect((await list(user, { limit: 0 })).status).toEqual(400);
    expect((await list(user, { query: "a".repeat(101) })).status).toEqual(400);
  });

  it("offers only readable documents outside AI-excluded collections", async () => {
    const user = await enable(await buildUser());
    const owner = await buildUser({ teamId: user.teamId });
    const open = await buildCollection({
      teamId: user.teamId,
      userId: user.id,
      name: "Engineering",
    });
    const excluded = await buildCollection({
      teamId: user.teamId,
      userId: user.id,
      aiExcluded: true,
    });
    const secret = await buildCollection({
      teamId: user.teamId,
      userId: owner.id,
      permission: null,
    });
    const doc = (title: string, collectionId: string, userId = user.id) =>
      buildDocument({ teamId: user.teamId, userId, collectionId, title });
    const runbook = await doc("Runbook alpha", open.id);
    await doc("Runbook excluded", excluded.id);
    await doc("Runbook secret", secret.id, owner.id);
    await buildDocument({ title: "Runbook elsewhere" });
    await buildDraftDocument({
      teamId: user.teamId,
      userId: owner.id,
      collectionId: open.id,
      title: "Runbook draft of someone else",
    });

    const res = await list(user, { query: "runbook" });
    expect(res.status).toEqual(200);
    const { data } = await res.json();
    expect(data).toEqual([
      {
        id: runbook.id,
        title: "Runbook alpha",
        url: `/doc/runbook-alpha-${runbook.urlId}`,
        collectionId: open.id,
        collectionName: "Engineering",
      },
    ]);
  });

  it("lists recent documents without a query, up to the limit", async () => {
    const user = await enable(await buildUser());
    const collection = await buildCollection({
      teamId: user.teamId,
      userId: user.id,
    });
    for (let i = 0; i < 3; i++) {
      await buildDocument({
        teamId: user.teamId,
        userId: user.id,
        collectionId: collection.id,
        title: `Doc ${i}`,
      });
    }

    const res = await list(user, { limit: 2 });
    expect(res.status).toEqual(200);
    expect((await res.json()).data).toHaveLength(2);
  });
});
