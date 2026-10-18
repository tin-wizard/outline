import { randomUUID } from "node:crypto";
import { subDays } from "date-fns";
import { vi } from "vitest";
import { TeamPreference } from "@shared/types";
import { sequelize } from "@server/storage/database";
import Redis from "@server/storage/redis";
import {
  AIConversation,
  AIConversationTurn,
  Document,
  Team,
} from "@server/models";
import type { User } from "@server/models";
import {
  buildApiKey,
  buildCollection,
  buildDocument,
  buildGuestUser,
  buildTeam,
  buildUser,
  buildViewer,
} from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import { splitBlocks } from "../blocks";
import { appendConversationTurn } from "../history";
import type { AcceptedBlock } from "../verify";

const server = getTestServer();

// Synthetic, assembled at runtime so the repository holds no credential-like literal.
const secret = "sk-ant-" + "api03-" + "a".repeat(30);

async function enable(user: User, history = true) {
  const team = await Team.findByPk(user.teamId, { rejectOnEmpty: true });
  team.setPreference(TeamPreference.AIAnswers, true);
  team.setPreference(TeamPreference.AIConversationHistory, history);
  await team.save();
  user.team = team;
  return user;
}

function released(text: string, documents: Document[]): AcceptedBlock {
  return {
    ok: true,
    block: splitBlocks(text)[0],
    citations: documents.map((d) => ({
      documentId: d.id,
      title: "ignored",
      url: "/doc/ignored",
      quote: "supporting quote",
      heading: "Section One",
      anchor: "h-section-one-1",
    })),
    modelCited: documents.length > 0,
  };
}

async function store(
  user: User,
  question: string,
  blocks: AcceptedBlock[] = [],
  conversationId?: string
): Promise<string> {
  const id = await appendConversationTurn(user, {
    conversationId,
    question,
    released: blocks,
    outcome: blocks.length ? "answered" : "no_answer",
    usageId: null,
  });
  if (!id) {
    throw new Error("not stored");
  }
  return id;
}

// Sequelize always overwrites updatedAt, so set the activity time directly.
const setUpdatedAt = (id: string, at: Date) =>
  sequelize.query(
    `UPDATE "ai_conversations" SET "updatedAt" = :at WHERE "id" = :id`,
    { replacements: { at, id } }
  );

const post = (path: string, user: User | undefined, body: object) =>
  user
    ? server.post(`/api/aiConversations.${path}`, user, { body })
    : server.post(`/api/aiConversations.${path}`, { body });

describe("aiConversations", () => {
  it("requires authentication", async () => {
    for (const path of ["list", "info", "update", "delete"]) {
      const res = await post(path, undefined, { id: randomUUID() });
      expect(res.status).toEqual(401);
    }
  });

  describe("gates", () => {
    it.each([
      ["guest", buildGuestUser],
      ["viewer", buildViewer],
    ])(
      "lets a %s list and delete their own chats but not open them",
      async (_role, build) => {
        const user = await enable(await build());
        const id = await store(user, "Kept from before?");
        const list = await post("list", user, {});
        expect(list.status).toEqual(200);
        expect(
          (await list.json()).data.map((c: { id: string }) => c.id)
        ).toEqual([id]);
        expect((await post("info", user, { id })).status).toEqual(403);
        expect(
          (await post("update", user, { id, pinned: true })).status
        ).toEqual(403);
        expect((await post("delete", user, { id })).status).toEqual(200);
        expect(await AIConversation.findByPk(id)).toBeNull();
      }
    );

    it("lists and deletes but does not open or change chats while history is off", async () => {
      const user = await enable(await buildUser());
      const id = await store(user, "Kept?");
      const second = await store(user, "Also kept?");
      const key = `aiconv:${user.teamId}:${user.id}:${id}`;
      await Redis.defaultClient.set(key, "{}", "EX", 60);
      await enable(user, false);

      const list = await post("list", user, {});
      expect(list.status).toEqual(200);
      const { data } = await list.json();
      expect(data.map((c: { id: string }) => c.id).sort()).toEqual(
        [id, second].sort()
      );
      // Metadata only.
      expect(data[0].turns).toBeUndefined();
      for (const path of ["info", "update"]) {
        const res = await post(path, user, { id, pinned: true });
        expect(res.status).toEqual(403);
        expect((await res.json()).message).toEqual(
          "AI conversation history is not enabled"
        );
      }

      expect((await post("delete", user, { id })).status).toEqual(200);
      expect(await AIConversation.findByPk(id)).toBeNull();
      expect(await Redis.defaultClient.exists(key)).toEqual(0);

      const team = await Team.findByPk(user.teamId, { rejectOnEmpty: true });
      team.setPreference(TeamPreference.AIAnswers, false);
      await team.save();
      expect((await post("list", user, {})).status).toEqual(200);
      expect((await post("info", user, { id: second })).status).toEqual(403);
      expect((await post("delete", user, { id: second })).status).toEqual(200);
      expect(await AIConversation.findByPk(second)).toBeNull();
    });

    it("returns 404 for foreign and missing ids on delete, with history off", async () => {
      const owner = await enable(await buildUser());
      const foreign = await store(owner, "Not yours");
      const user = await buildUser({ teamId: owner.teamId });
      await enable(user, false);
      expect((await post("delete", user, { id: foreign })).status).toEqual(404);
      expect((await post("delete", user, { id: randomUUID() })).status).toEqual(
        404
      );
      expect(await AIConversation.findByPk(foreign)).not.toBeNull();
    });

    it("refuses API keys on every route", async () => {
      const user = await enable(await buildUser());
      const id = await store(user, "Private?");
      const key = await buildApiKey({ userId: user.id });
      for (const path of ["list", "info", "update", "delete"]) {
        const res = await server.post(`/api/aiConversations.${path}`, {
          body: { id, pinned: true },
          headers: { Authorization: `Bearer ${key.value}` },
        });
        expect([401, 403]).toContain(res.status);
      }
      expect(await AIConversation.findByPk(id)).not.toBeNull();
    });

    it("returns 403 for info when AI answers are off", async () => {
      const user = await enable(await buildUser());
      const id = await store(user, "Kept?");
      const team = await Team.findByPk(user.teamId, { rejectOnEmpty: true });
      team.setPreference(TeamPreference.AIAnswers, false);
      await team.save();
      expect((await post("info", user, { id })).status).toEqual(403);
    });
  });

  describe("#list", () => {
    it("lists only the user's own conversations, pinned first then newest", async () => {
      const user = await enable(await buildUser());
      const sameTeam = await enable(await buildUser({ teamId: user.teamId }));
      const otherTeam = await enable(
        await buildUser({ teamId: (await buildTeam()).id })
      );
      const older = await store(user, "Older question");
      const newer = await store(user, "Newer question");
      const pinned = await store(user, "Pinned question");
      await setUpdatedAt(older, subDays(new Date(), 2));
      await setUpdatedAt(pinned, subDays(new Date(), 5));
      await AIConversation.update(
        { pinnedAt: new Date() },
        { where: { id: pinned }, silent: true }
      );
      const foreign = [
        await store(sameTeam, "Not yours"),
        await store(otherTeam, "Not yours"),
      ];

      const res = await post("list", user, {});
      expect(res.status).toEqual(200);
      const body = await res.json();
      expect(body.data.map((c: { id: string }) => c.id)).toEqual([
        pinned,
        newer,
        older,
      ]);
      expect(body.pagination.total).toEqual(3);
      for (const id of foreign) {
        expect(JSON.stringify(body)).not.toContain(id);
      }
      expect(Object.keys(body.data[0]).sort()).toEqual([
        "createdAt",
        "id",
        "pinnedAt",
        "title",
        "updatedAt",
      ]);

      const onlyPinned = await (
        await post("list", user, { pinned: true })
      ).json();
      expect(onlyPinned.data.map((c: { id: string }) => c.id)).toEqual([
        pinned,
      ]);
    });

    it("searches titles and questions, case-insensitively and escaped", async () => {
      const user = await enable(await buildUser());
      const byTitle = await store(user, "Holiday policy");
      const byQuestion = await store(user, "First thing");
      await store(user, "And what about PARKING?", [], byQuestion);
      await store(user, "Unrelated");
      const other = await enable(await buildUser({ teamId: user.teamId }));
      await store(other, "Parking for others");

      const ids = async (query: string) =>
        (await (await post("list", user, { query })).json()).data.map(
          (c: { id: string }) => c.id
        );
      expect(await ids("holiday")).toEqual([byTitle]);
      expect(await ids("parking")).toEqual([byQuestion]);
      expect(await ids("%")).toEqual([]);
      expect(await ids("_")).toEqual([]);
    });
  });

  describe("#info", () => {
    it("returns turns with fresh titles and section urls", async () => {
      const user = await enable(await buildUser());
      const doc = await buildDocument({
        teamId: user.teamId,
        userId: user.id,
        title: "Booking Guide",
      });
      const id = await store(user, "What is BOSS?", [
        released("BOSS API is the booking service.", [doc]),
      ]);
      await doc.update({ title: "Renamed Guide" });

      const res = await post("info", user, { id });
      expect(res.status).toEqual(200);
      const { data } = await res.json();
      expect(data.id).toEqual(id);
      expect(data.userId).toBeUndefined();
      expect(data.teamId).toBeUndefined();
      const [turn] = data.turns;
      expect(turn.question).toEqual("What is BOSS?");
      expect(turn.hasHiddenBlocks).toEqual(false);
      expect(turn.sources).toEqual([
        {
          n: 1,
          documentId: doc.id,
          title: "Renamed Guide",
          url: `/doc/renamed-guide-${doc.urlId}`,
        },
      ]);
      expect(turn.blocks).toEqual([
        {
          kind: "paragraph",
          markdown: "BOSS API is the booking service.",
          citations: [
            {
              n: 1,
              documentId: doc.id,
              title: "Renamed Guide",
              url: `/doc/renamed-guide-${doc.urlId}#h-section-one-1`,
              quote: "supporting quote",
            },
          ],
        },
      ]);
    });

    it("hides every block of a turn once any of its sources is no longer readable", async () => {
      const user = await enable(await buildUser());
      const author = await buildUser({ teamId: user.teamId });
      const collection = await buildCollection({
        teamId: user.teamId,
        userId: user.id,
      });
      const make = (owner: User = author) =>
        buildDocument({
          teamId: user.teamId,
          userId: owner.id,
          collectionId: collection.id,
        });
      const kept = await make();
      const deleted = await make();
      const unpublished = await make();
      const ownDraft = await make(user);
      const id = await store(user, "Kept?", [
        released("# Kept heading", []),
        released("Kept block text.", [kept]),
        released("Own draft block text.", [ownDraft]),
      ]);
      await store(
        user,
        "Deleted?",
        [
          released("# Heading from the deleted source", []),
          released("Deleted block text.", [deleted]),
        ],
        id
      );
      await store(
        user,
        "Unpublished?",
        [released("Unpublished block text.", [unpublished])],
        id
      );
      await store(user, "Nothing found?", [], id);
      await deleted.destroy();
      await unpublished.update({ publishedAt: null });
      await ownDraft.update({ publishedAt: null });

      const res = await post("info", user, { id });
      const turns = (await res.json()).data.turns;
      const shown = turns.map(
        (t: { blocks: { hidden?: boolean; markdown?: string }[] }) =>
          t.blocks.map((b) => (b.hidden ? "hidden" : b.markdown))
      );
      expect(shown).toEqual([
        ["# Kept heading", "Kept block text.", "Own draft block text."],
        ["hidden", "hidden"],
        ["hidden"],
        [],
      ]);
      expect(
        turns.map((t: { hasHiddenBlocks: boolean }) => t.hasHiddenBlocks)
      ).toEqual([false, true, true, false]);
      expect(turns[1].blocks[0]).toEqual({ hidden: true, kind: "heading" });
      expect(turns[1].sources).toEqual([]);
      const serialized = JSON.stringify(turns);
      expect(serialized).not.toContain(deleted.id);
      expect(serialized).not.toContain(unpublished.id);
      expect(serialized).not.toContain("Heading from the deleted source");
    });

    it("hides every cited turn when sources cannot be re-checked", async () => {
      const user = await enable(await buildUser());
      const doc = await buildDocument({ teamId: user.teamId, userId: user.id });
      const id = await store(user, "Cited?", [
        released("# Heading", []),
        released("Cited block text.", [doc]),
      ]);
      await store(user, "Uncited?", [released("Plain gap statement.", [])], id);
      vi.spyOn(Document, "findByIds").mockRejectedValueOnce(new Error("down"));
      const turns = (await (await post("info", user, { id })).json()).data
        .turns;
      vi.restoreAllMocks();
      expect(turns[0].blocks).toEqual([
        { hidden: true, kind: "heading" },
        { hidden: true, kind: "paragraph" },
      ]);
      expect(turns[1].blocks[0].markdown).toEqual("Plain gap statement.");
    });

    it("hides turns citing a collection newly excluded from AI or without access", async () => {
      const user = await enable(await buildUser());
      const collection = await buildCollection({
        teamId: user.teamId,
        userId: user.id,
      });
      const doc = await buildDocument({
        teamId: user.teamId,
        userId: user.id,
        collectionId: collection.id,
      });
      const other = await buildUser({ teamId: user.teamId });
      const privateCollection = await buildCollection({
        teamId: user.teamId,
        userId: other.id,
        permission: null,
      });
      const privateDoc = await buildDocument({
        teamId: user.teamId,
        userId: other.id,
        collectionId: privateCollection.id,
      });
      const id = await store(user, "Excluded?", [
        released("# Lead-in", []),
        released("Excluded block text.", [doc]),
      ]);
      await store(
        user,
        "Private?",
        [released("Private block text.", [privateDoc])],
        id
      );

      let turns = (await (await post("info", user, { id })).json()).data.turns;
      expect(turns[0].blocks[1].markdown).toEqual("Excluded block text.");
      expect(turns[1].blocks[0]).toEqual({ hidden: true, kind: "paragraph" });

      await collection.update({ aiExcluded: true });
      turns = (await (await post("info", user, { id })).json()).data.turns;
      expect(turns[0].blocks).toEqual([
        { hidden: true, kind: "heading" },
        { hidden: true, kind: "paragraph" },
      ]);
      expect(turns[0].sources).toEqual([]);
    });

    it("returns the same 404 for missing and foreign ids", async () => {
      const user = await enable(await buildUser());
      const sameTeam = await enable(await buildUser({ teamId: user.teamId }));
      const otherTeam = await enable(
        await buildUser({ teamId: (await buildTeam()).id })
      );
      const ids = [
        await store(sameTeam, "Theirs"),
        await store(otherTeam, "Theirs"),
        randomUUID(),
      ];
      for (const id of ids) {
        for (const path of ["info", "update", "delete"]) {
          const res = await post(path, user, { id, pinned: true });
          expect(res.status).toEqual(404);
        }
      }
      expect(
        await AIConversation.count({ where: { id: ids.slice(0, 2) } })
      ).toEqual(2);
      expect(
        (await AIConversation.findByPk(ids[0], { rejectOnEmpty: true }))
          .pinnedAt
      ).toBeNull();
    });
  });

  describe("#update", () => {
    it("renames with a trimmed, redacted title and pins without reordering", async () => {
      const user = await enable(await buildUser());
      const id = await store(user, "Original");
      const before = await AIConversation.findByPk(id, {
        rejectOnEmpty: true,
      });

      let res = await post("update", user, {
        id,
        title: `  Keys ${secret}  `,
      });
      expect(res.status).toEqual(200);
      let { data } = await res.json();
      expect(data.title.startsWith("Keys ")).toBe(true);
      expect(data.title).not.toContain(secret);

      res = await post("update", user, { id, pinned: true });
      ({ data } = await res.json());
      expect(data.pinnedAt).not.toBeNull();
      res = await post("update", user, { id, pinned: false });
      ({ data } = await res.json());
      expect(data.pinnedAt).toBeNull();

      const after = await AIConversation.findByPk(id, { rejectOnEmpty: true });
      expect(after.updatedAt.getTime()).toEqual(before.updatedAt.getTime());
    });

    it.each([[""], ["   "], ["x".repeat(81)]])(
      "rejects the title %j",
      async (title) => {
        const user = await enable(await buildUser());
        const id = await store(user, "Original");
        expect((await post("update", user, { id, title })).status).toEqual(400);
      }
    );

    it("requires a change", async () => {
      const user = await enable(await buildUser());
      const id = await store(user, "Original");
      expect((await post("update", user, { id })).status).toEqual(400);
    });
  });

  describe("#delete", () => {
    it("deletes the conversation, its turns and its hot cache", async () => {
      const user = await enable(await buildUser());
      const id = await store(user, "First");
      await store(user, "Second", [], id);
      const key = `aiconv:${user.teamId}:${user.id}:${id}`;
      await Redis.defaultClient.set(key, "{}", "EX", 60);

      const res = await post("delete", user, { id });
      expect(res.status).toEqual(200);
      expect(await AIConversation.findByPk(id)).toBeNull();
      expect(
        await AIConversationTurn.count({ where: { conversationId: id } })
      ).toEqual(0);
      expect(await Redis.defaultClient.exists(key)).toEqual(0);
    });
  });
});
