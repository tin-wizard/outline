import { TeamPreference } from "@shared/types";
import { Team, type User } from "@server/models";
import { sequelize } from "@server/storage/database";
import {
  buildCollection,
  buildDocument,
  buildDraftDocument,
  buildGuestUser,
  buildTemplate,
  buildUser,
  buildViewer,
} from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import { retrieveSources } from "../retrieve";

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

  it("offers no drafts, not even the user's own, and no templates", async () => {
    const user = await enable(await buildUser());
    const collection = await buildCollection({
      teamId: user.teamId,
      userId: user.id,
    });
    const published = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
      collectionId: collection.id,
      title: "Runbook published",
    });
    await buildDraftDocument({
      teamId: user.teamId,
      userId: user.id,
      collectionId: collection.id,
      title: "Runbook my draft",
    });
    await buildTemplate({
      teamId: user.teamId,
      userId: user.id,
      collectionId: collection.id,
      title: "Runbook template",
    });

    const res = await list(user, { query: "runbook" });
    expect((await res.json()).data.map((d: { id: string }) => d.id)).toEqual([
      published.id,
    ]);
  });

  it("offers archived documents, as retrieval uses them too", async () => {
    const user = await enable(await buildUser());
    const collection = await buildCollection({
      teamId: user.teamId,
      userId: user.id,
    });
    const archived = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
      collectionId: collection.id,
      title: "Runbook archived",
      text: "# Parking\nparking rules for staff",
    });
    await archived.update({ archivedAt: new Date() });

    const sources = await retrieveSources(user, { query: "parking rules" });
    expect(sources.map((s) => s.document.id)).toEqual([archived.id]);
    const res = await list(user, { query: "runbook" });
    expect((await res.json()).data.map((d: { id: string }) => d.id)).toEqual([
      archived.id,
    ]);
  });

  it("tops the list up to the limit when newer matches are left out", async () => {
    const user = await enable(await buildUser());
    const open = await buildCollection({
      teamId: user.teamId,
      userId: user.id,
    });
    const excluded = await buildCollection({
      teamId: user.teamId,
      userId: user.id,
      aiExcluded: true,
    });
    const add = (title: string, collectionId: string, at: string) =>
      buildDocument({
        teamId: user.teamId,
        userId: user.id,
        collectionId,
        title,
      }).then((d) =>
        sequelize.query(
          `UPDATE "documents" SET "updatedAt" = :at WHERE "id" = :id`,
          { replacements: { at, id: d.id } }
        )
      );
    // Two older usable documents behind seven newer excluded ones.
    await add("Runbook older 1", open.id, "2026-01-01T00:00:00Z");
    await add("Runbook older 2", open.id, "2026-01-02T00:00:00Z");
    for (let i = 0; i < 7; i++) {
      await add(`Runbook new ${i}`, excluded.id, `2026-06-0${i + 1}T00:00:00Z`);
    }

    const res = await list(user, { query: "runbook", limit: 2 });
    expect(
      (await res.json()).data.map((d: { title: string }) => d.title).sort()
    ).toEqual(["Runbook older 1", "Runbook older 2"]);
  });
});
