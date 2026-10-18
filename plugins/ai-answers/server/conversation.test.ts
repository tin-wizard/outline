import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import Redis from "@server/storage/redis";
import { CollectionPermission, DocumentPermission } from "@shared/types";
import { GroupMembership, User, UserMembership } from "@server/models";
import {
  buildCollection,
  buildDocument,
  buildDraftDocument,
  buildGroup,
  buildGroupUser,
  buildGuestUser,
  buildTeam,
  buildUser,
} from "@server/test/factories";
import { splitBlocks } from "./blocks";
import {
  CONVERSATION_TTL_SECONDS,
  HISTORY_TOKEN_BUDGET,
  MAX_TURNS,
  appendTurn,
  buildStandaloneQuery,
  createConversation,
  deleteConversation,
  historyForModel,
  loadConversation,
  seedConversation,
  type TurnInput,
} from "./conversation";
import { retrieveSources } from "./retrieve";
import type { AcceptedBlock } from "./verify";

function key(teamId: string, userId: string, id: string) {
  return `aiconv:${teamId}:${userId}:${id}`;
}

/** A released (verified) paragraph citing the given documents. */
function released(text: string, documentIds: string[]): AcceptedBlock {
  return {
    ok: true,
    block: splitBlocks(text)[0],
    citations: documentIds.map((documentId) => ({
      documentId,
      title: "t",
      url: "/doc/t",
      quote: "q",
    })),
    modelCited: documentIds.length > 0,
  };
}

/** A turn input as 2.1 would build it from the verifier's released blocks. */
function turn(
  overrides: {
    question?: string;
    answer?: string | null;
    citedDocumentIds?: string[];
  } = {}
): TurnInput {
  const answer =
    overrides.answer === undefined
      ? "BOSS API is the booking service."
      : overrides.answer;
  return {
    question: overrides.question ?? "What is BOSS API?",
    released:
      answer === null
        ? []
        : [released(answer, overrides.citedDocumentIds ?? [randomUUID()])],
  };
}

async function setupUser() {
  const team = await buildTeam();
  const user = await buildUser({ teamId: team.id });
  return { team, user };
}

/** A reader who can see a collection only while it stays team-readable. */
async function setupScripted() {
  const team = await buildTeam();
  const owner = await buildUser({ teamId: team.id });
  const reader = await buildUser({ teamId: team.id });
  const collection = await buildCollection({
    teamId: team.id,
    userId: owner.id,
  });
  const boss = await buildDocument({
    teamId: team.id,
    userId: owner.id,
    collectionId: collection.id,
    title: "BOSS API",
    text: "# Overview\nThe BOSS API books rooms for guests.",
  });
  await buildDocument({
    teamId: team.id,
    userId: owner.id,
    collectionId: collection.id,
    title: "Lifescape integration",
    text: "# Sync\nLifescape calls the BOSS API nightly to sync bookings.",
  });
  const created = await createConversation(reader);
  if (!created) {
    throw new Error("conversation not created");
  }
  await appendTurn(
    reader,
    created.id,
    turn({
      question: "What is BOSS API?",
      answer: "The BOSS API books rooms for guests.",
      citedDocumentIds: [boss.id],
    })
  );
  const loaded = await loadConversation(reader, created.id);
  if (!loaded.conversation) {
    throw new Error("conversation not loaded");
  }
  return {
    team,
    owner,
    reader,
    collection,
    boss,
    conversation: loaded.conversation,
  };
}

const FOLLOW_UP = "How does it connect to Lifescape?";
const PRIOR_QUESTION = "What is BOSS API?";

/** "BOSS API" occurrences beyond the one in the user's own prior question. */
function titleMentions(query: string) {
  const all = query.match(/BOSS API/g)?.length ?? 0;
  return query.includes(PRIOR_QUESTION) ? all - 1 : all;
}

describe("conversation store", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates, appends and loads a conversation", async () => {
    const { user } = await setupUser();
    const created = await createConversation(user);
    expect(created).not.toBeNull();
    expect(created?.turns).toEqual([]);
    const id = created?.id ?? "";

    expect(await appendTurn(user, id, turn())).toEqual(true);
    const loaded = await loadConversation(user, id);

    expect(loaded.unavailable).toEqual(false);
    expect(loaded.conversation?.id).toEqual(id);
    expect(loaded.conversation?.teamId).toEqual(user.teamId);
    expect(loaded.conversation?.userId).toEqual(user.id);
    expect(loaded.conversation?.turns.map((t) => t.question)).toEqual([
      "What is BOSS API?",
    ]);
  });

  it("uses a one hour TTL that slides on read and append", async () => {
    const { user } = await setupUser();
    const created = await createConversation(user);
    const id = created?.id ?? "";
    const k = key(user.teamId, user.id, id);
    expect(CONVERSATION_TTL_SECONDS).toEqual(3600);
    expect(await Redis.defaultClient.ttl(k)).toBeGreaterThan(3590);

    await Redis.defaultClient.expire(k, 100);
    await loadConversation(user, id);
    expect(await Redis.defaultClient.ttl(k)).toBeGreaterThan(3590);

    await Redis.defaultClient.expire(k, 100);
    await appendTurn(user, id, turn());
    expect(await Redis.defaultClient.ttl(k)).toBeGreaterThan(3590);
  });

  it("keeps at most 8 turns, dropping the oldest", async () => {
    const { user } = await setupUser();
    const id = (await createConversation(user))?.id ?? "";
    for (let i = 1; i <= MAX_TURNS + 1; i++) {
      await appendTurn(user, id, turn({ question: `Question ${i}` }));
    }
    const loaded = await loadConversation(user, id);
    const questions = loaded.conversation?.turns.map((t) => t.question);
    expect(questions?.length).toEqual(8);
    expect(questions?.[0]).toEqual("Question 2");
    expect(questions?.[7]).toEqual("Question 9");
  });

  it("trims the oldest answers first to stay within the history budget", async () => {
    const { user } = await setupUser();
    const id = (await createConversation(user))?.id ?? "";
    // Each answer is ~2,500 tokens (chars / 3), so three exceed 6,000.
    const big = "a".repeat(7500);
    for (let i = 1; i <= 3; i++) {
      await appendTurn(user, id, turn({ question: `Q${i}`, answer: big }));
    }
    const turns = (await loadConversation(user, id)).conversation?.turns ?? [];
    expect(HISTORY_TOKEN_BUDGET).toEqual(6000);
    expect(turns.map((t) => t.question)).toEqual(["Q1", "Q2", "Q3"]);
    expect(turns[0].answer).toBeNull();
    expect(turns[1].answer).toEqual(big);
    expect(turns[2].answer).toEqual(big);
  });

  it("drops older whole turns before clearing the newest answer", async () => {
    const { user } = await setupUser();
    const id = (await createConversation(user))?.id ?? "";
    for (let i = 1; i <= 7; i++) {
      await appendTurn(
        user,
        id,
        turn({ question: `${i}`.padEnd(500, "q"), answer: null })
      );
    }
    const big = "b".repeat(16_000);
    await appendTurn(user, id, turn({ question: "Last", answer: big }));
    const turns = (await loadConversation(user, id)).conversation?.turns ?? [];
    expect(turns.length).toBeLessThan(8);
    expect(turns.at(-1)?.question).toEqual("Last");
    expect(turns.at(-1)?.answer).toEqual(big);
  });

  it("seeds a conversation under a given id with the same caps, budget and TTL", async () => {
    const { user } = await setupUser();
    const id = randomUUID();
    const big = "a".repeat(7500);
    const turns = Array.from({ length: MAX_TURNS + 1 }, (_, i) => ({
      question: `Q${i + 1}`,
      answer: big,
      citedDocumentIds: [randomUUID()],
      at: i,
    }));

    const seeded = await seedConversation(user, id, turns);
    expect(seeded.id).toEqual(id);
    expect(seeded.turns.map((t) => t.question)).toEqual(
      turns.slice(1).map((t) => t.question)
    );
    // Same rule as appendTurn: the oldest answers are cleared first.
    expect(seeded.turns.at(-1)?.answer).toEqual(big);
    expect(seeded.turns[0].answer).toBeNull();
    expect(
      await Redis.defaultClient.ttl(key(user.teamId, user.id, id))
    ).toBeGreaterThan(3590);
    expect((await loadConversation(user, id)).conversation).toEqual(seeded);
    expect(await appendTurn(user, id, turn({ question: "Next" }))).toEqual(
      true
    );

    const other = await buildUser({ teamId: user.teamId });
    expect((await loadConversation(other, id)).conversation).toBeNull();
  });

  it("returns the seeded conversation even when Redis fails", async () => {
    const { user } = await setupUser();
    vi.spyOn(Redis.defaultClient, "set").mockRejectedValueOnce(
      new Error("redis down")
    );
    const id = randomUUID();
    const seeded = await seedConversation(user, id, [
      { question: "Q", answer: "A", citedDocumentIds: [], at: 1 },
    ]);
    expect(seeded.turns.map((t) => t.question)).toEqual(["Q"]);
    expect((await loadConversation(user, id)).conversation).toBeNull();
  });

  it("stores the derived answer and deduplicated cited document ids", async () => {
    const { user } = await setupUser();
    const id = (await createConversation(user))?.id ?? "";
    const a = randomUUID();
    const b = randomUUID();
    await appendTurn(user, id, {
      question: "Q",
      released: [
        released("First claim.", [a]),
        released("Second claim.", [a, b]),
      ],
    });
    const stored = (await loadConversation(user, id)).conversation?.turns[0];
    expect(stored?.answer).toEqual("First claim.\n\nSecond claim.");
    expect(stored?.citedDocumentIds).toEqual([a, b]);
  });

  it("stores an abstention as a question with no answer or citations", async () => {
    const { user } = await setupUser();
    const id = (await createConversation(user))?.id ?? "";
    await appendTurn(user, id, { question: "Q", released: [] });
    const stored = (await loadConversation(user, id)).conversation?.turns[0];
    expect(stored?.answer).toBeNull();
    expect(stored?.citedDocumentIds).toEqual([]);
  });

  it("enforces size limits on stored turns", async () => {
    const { user } = await setupUser();
    const id = (await createConversation(user))?.id ?? "";
    await appendTurn(user, id, turn({ question: "x".repeat(600) }));
    await appendTurn(user, id, turn({ answer: "y".repeat(18_000) }));
    await appendTurn(
      user,
      id,
      turn({
        citedDocumentIds: Array.from({ length: 21 }, () => randomUUID()),
      })
    );
    const turns = (await loadConversation(user, id)).conversation?.turns ?? [];
    expect(turns[0].question.length).toEqual(500);
    expect(turns[1].answer).toBeNull();
    expect(turns[1].citedDocumentIds).toEqual([]);
    expect(turns[2].answer).toBeNull();
    expect(turns[2].citedDocumentIds).toEqual([]);
  });

  it("redacts secrets in the question before storing it", async () => {
    const { user } = await setupUser();
    const id = (await createConversation(user))?.id ?? "";
    const secret = "sk-ant-api03-" + "a".repeat(30);
    await appendTurn(user, id, turn({ question: `Why does ${secret} fail?` }));
    const raw = await Redis.defaultClient.get(key(user.teamId, user.id, id));
    expect(raw).not.toContain(secret);
    expect(raw).toContain("[REDACTED:");
  });

  it("does not resurrect a deleted conversation on append", async () => {
    const { user } = await setupUser();
    const id = (await createConversation(user))?.id ?? "";
    await deleteConversation(user, id);
    expect(await appendTurn(user, id, turn())).toEqual(false);
    expect(
      await Redis.defaultClient.exists(key(user.teamId, user.id, id))
    ).toEqual(0);
  });

  it("does not resurrect a conversation deleted between read and write", async () => {
    const { user } = await setupUser();
    const id = (await createConversation(user))?.id ?? "";
    const k = key(user.teamId, user.id, id);
    const multi = Redis.defaultClient.multi.bind(Redis.defaultClient);
    vi.spyOn(Redis.defaultClient, "multi").mockImplementation(() => {
      const pipeline = multi();
      const exec = pipeline.exec.bind(pipeline);
      vi.spyOn(pipeline, "exec").mockImplementation(async () => {
        const result = await exec();
        await Redis.defaultClient.del(k);
        return result;
      });
      return pipeline;
    });
    expect(await appendTurn(user, id, turn())).toEqual(false);
    vi.restoreAllMocks();
    expect(await Redis.defaultClient.exists(k)).toEqual(0);
  });

  it("misses another user's conversation in the same team", async () => {
    const { team, user } = await setupUser();
    const other = await buildUser({ teamId: team.id });
    const id = (await createConversation(user))?.id ?? "";
    await appendTurn(user, id, turn());

    const loaded = await loadConversation(other, id);
    expect(loaded).toEqual({ conversation: null, unavailable: false });
    expect(await appendTurn(other, id, turn({ question: "forged" }))).toEqual(
      false
    );
    expect(await deleteConversation(other, id)).toEqual(false);
    // The owner's conversation is untouched.
    const own = await loadConversation(user, id);
    expect(own.conversation?.turns.length).toEqual(1);
  });

  it("misses a conversation from another team", async () => {
    const { user } = await setupUser();
    const { user: stranger } = await setupUser();
    const id = (await createConversation(user))?.id ?? "";
    expect((await loadConversation(stranger, id)).conversation).toBeNull();
  });

  it("misses forged, malformed and unknown ids", async () => {
    const { user } = await setupUser();
    expect(
      (await loadConversation(user, randomUUID())).conversation
    ).toBeNull();
    expect((await loadConversation(user, "*")).conversation).toBeNull();
    expect((await loadConversation(user, "x:y:z")).conversation).toBeNull();
  });

  it("rejects a stored value whose owner fields do not match the key", async () => {
    const { user } = await setupUser();
    const id = randomUUID();
    await Redis.defaultClient.set(
      key(user.teamId, user.id, id),
      JSON.stringify({
        id,
        teamId: user.teamId,
        userId: randomUUID(),
        turns: [],
      }),
      "EX",
      60
    );
    expect((await loadConversation(user, id)).conversation).toBeNull();
  });

  it("deletes a conversation", async () => {
    const { user } = await setupUser();
    const id = (await createConversation(user))?.id ?? "";
    expect(await deleteConversation(user, id)).toEqual(true);
    expect((await loadConversation(user, id)).conversation).toBeNull();
  });

  describe("when Redis fails", () => {
    it("create returns null without throwing", async () => {
      const { user } = await setupUser();
      vi.spyOn(Redis.defaultClient, "set").mockRejectedValue(
        new Error("redis down")
      );
      expect(await createConversation(user)).toBeNull();
    });

    it("load reports no history and flags it as unavailable", async () => {
      const { user } = await setupUser();
      const id = (await createConversation(user))?.id ?? "";
      vi.spyOn(Redis.defaultClient, "multi").mockImplementation(() => {
        throw new Error("redis down");
      });
      expect(await loadConversation(user, id)).toEqual({
        conversation: null,
        unavailable: true,
      });
    });

    it("load treats corrupt JSON as no conversation without throwing", async () => {
      const { user } = await setupUser();
      const id = randomUUID();
      await Redis.defaultClient.set(
        key(user.teamId, user.id, id),
        "{not json",
        "EX",
        60
      );
      expect(await loadConversation(user, id)).toEqual({
        conversation: null,
        unavailable: false,
      });
    });

    it("load reports unavailable when a command inside exec fails", async () => {
      const { user } = await setupUser();
      const id = (await createConversation(user))?.id ?? "";
      const multi = Redis.defaultClient.multi.bind(Redis.defaultClient);
      vi.spyOn(Redis.defaultClient, "multi").mockImplementation(() => {
        const pipeline = multi();
        vi.spyOn(pipeline, "exec").mockResolvedValue([
          [new Error("WRONGTYPE"), null],
          [null, 1],
        ]);
        return pipeline;
      });
      expect(await loadConversation(user, id)).toEqual({
        conversation: null,
        unavailable: true,
      });
    });

    it("append returns false without throwing", async () => {
      const { user } = await setupUser();
      const id = (await createConversation(user))?.id ?? "";
      vi.spyOn(Redis.defaultClient, "set").mockRejectedValue(
        new Error("redis down")
      );
      expect(await appendTurn(user, id, turn())).toEqual(false);
    });

    it("delete returns false without throwing", async () => {
      const { user } = await setupUser();
      vi.spyOn(Redis.defaultClient, "del").mockRejectedValue(
        new Error("redis down")
      );
      expect(await deleteConversation(user, randomUUID())).toEqual(false);
    });
  });
});

/** Whether `user` still gets the title and prior answer of a turn citing `doc`. */
async function carriesForward(
  user: { id: string; teamId: string },
  doc: { id: string; title: string }
) {
  const conversation = {
    id: randomUUID(),
    teamId: user.teamId,
    userId: user.id,
    turns: [
      {
        question: "Tell me more",
        answer: "Prior answer text.",
        citedDocumentIds: [doc.id],
        at: Date.now(),
      },
    ],
  };
  const fullUser = await User.findByPk(user.id, { rejectOnEmpty: true });
  const query = await buildStandaloneQuery(fullUser, conversation, "And?");
  const history = await historyForModel(fullUser, conversation);
  return {
    title: query.includes(doc.title),
    answer: history[0]?.answer === "Prior answer text.",
  };
}

describe("buildStandaloneQuery and historyForModel", () => {
  it("resolves a pronoun follow-up to the cited document title", async () => {
    const { reader, conversation } = await setupScripted();

    const query = await buildStandaloneQuery(reader, conversation, FOLLOW_UP);

    expect(query).toContain("BOSS API");
    expect(query).toContain("Lifescape");
    expect(titleMentions(query)).toEqual(1);
    // The query finds the document that connects the two.
    const sources = await retrieveSources(reader, { query });
    expect(sources.map((s) => s.document.title)).toContain(
      "Lifescape integration"
    );
  });

  it("includes a prior answer while every cited document is readable", async () => {
    const { reader, conversation } = await setupScripted();
    expect(await historyForModel(reader, conversation)).toEqual([
      {
        question: "What is BOSS API?",
        answer: "The BOSS API books rooms for guests.",
      },
    ]);
  });

  it("drops the whole prior turn, question included, after access is revoked", async () => {
    const { reader, collection, conversation } = await setupScripted();
    await collection.update({ permission: null });

    const query = await buildStandaloneQuery(
      reader,
      conversation,
      "How does that relate to sync?"
    );
    expect(query).toEqual("How does that relate to sync?");
    expect(await historyForModel(reader, conversation)).toEqual([]);
  });

  it("keeps the question of a turn that cited nothing", async () => {
    const { reader, conversation } = await setupScripted();
    const uncited = {
      ...conversation,
      turns: [{ ...conversation.turns[0], answer: null, citedDocumentIds: [] }],
    };
    expect(await historyForModel(reader, uncited)).toEqual([
      { question: "What is BOSS API?", answer: null },
    ]);
    expect(await buildStandaloneQuery(reader, uncited, "Why?")).toEqual(
      "Why? What is BOSS API?"
    );
  });

  it("drops the title and prior answer after the document is deleted", async () => {
    const { reader, boss, conversation } = await setupScripted();
    await boss.destroy();

    const query = await buildStandaloneQuery(reader, conversation, "Why?");
    expect(query).toEqual("Why?");
    expect(await historyForModel(reader, conversation)).toEqual([]);
  });

  it("drops the title and prior answer once the collection is excluded from AI", async () => {
    const { reader, collection, conversation } = await setupScripted();
    await collection.update({ aiExcluded: true });

    const query = await buildStandaloneQuery(
      reader,
      conversation,
      "How does that relate to sync?"
    );
    expect(query).toEqual("How does that relate to sync?");
    expect(await historyForModel(reader, conversation)).toEqual([]);
  });

  it("omits the turn when only some of its cited documents remain readable", async () => {
    const { team, owner, reader, boss, conversation } = await setupScripted();
    const hidden = await buildCollection({
      teamId: team.id,
      userId: owner.id,
      permission: null,
    });
    const secret = await buildDocument({
      teamId: team.id,
      userId: owner.id,
      collectionId: hidden.id,
      title: "Secret plan",
    });
    const mixed = {
      ...conversation,
      turns: [
        { ...conversation.turns[0], citedDocumentIds: [boss.id, secret.id] },
      ],
    };

    const query = await buildStandaloneQuery(reader, mixed, FOLLOW_UP);
    expect(query).toEqual(FOLLOW_UP);
    expect(await historyForModel(reader, mixed)).toEqual([]);
  });

  it("returns nothing for a conversation owned by someone else", async () => {
    const { team, conversation } = await setupScripted();
    const other = await buildUser({ teamId: team.id });
    expect(await historyForModel(other, conversation)).toEqual([]);
    const query = await buildStandaloneQuery(other, conversation, FOLLOW_UP);
    expect(query).toEqual(FOLLOW_UP);
  });

  it("redacts secrets from stored questions in the standalone query", async () => {
    const { reader, conversation } = await setupScripted();
    const secret = "sk-ant-api03-" + "a".repeat(30);
    const withSecret = {
      ...conversation,
      turns: [
        {
          ...conversation.turns[0],
          question: `Why does key ${secret} fail on BOSS API?`,
        },
      ],
    };
    const query = await buildStandaloneQuery(reader, withSecret, FOLLOW_UP);
    expect(query).not.toContain(secret);
    expect(query).toContain("[REDACTED:");
    const history = await historyForModel(reader, withSecret);
    expect(history[0].question).not.toContain(secret);
  });
  describe("re-authorization matches what search returns", () => {
    async function privateSetup() {
      const team = await buildTeam();
      const owner = await buildUser({ teamId: team.id });
      const reader = await buildUser({ teamId: team.id });
      const collection = await buildCollection({
        teamId: team.id,
        userId: owner.id,
        permission: null,
      });
      const doc = await buildDocument({
        teamId: team.id,
        userId: owner.id,
        collectionId: collection.id,
        title: "Private spec",
      });
      return { team, owner, reader, collection, doc };
    }

    it("drops a cited document once its author unpublishes it, for others only", async () => {
      const { owner, reader, boss } = await setupScripted();
      expect(await carriesForward(reader, boss)).toEqual({
        title: true,
        answer: true,
      });
      await boss.update({ publishedAt: null });
      expect(await carriesForward(reader, boss)).toEqual({
        title: false,
        answer: false,
      });
      expect(await carriesForward(owner, boss)).toEqual({
        title: true,
        answer: true,
      });
    });

    it("treats another user's draft as unreadable", async () => {
      const { team, owner, reader, collection } = await setupScripted();
      const draft = await buildDraftDocument({
        teamId: team.id,
        userId: owner.id,
        collectionId: collection.id,
        title: "Draft roadmap",
      });
      expect(await carriesForward(reader, draft)).toEqual({
        title: false,
        answer: false,
      });
    });

    it("treats a template as unreadable", async () => {
      const { team, owner, reader, collection } = await setupScripted();
      const template = await buildDocument({
        teamId: team.id,
        userId: owner.id,
        collectionId: collection.id,
        title: "Meeting template",
        template: true,
      });
      expect(await carriesForward(reader, template)).toEqual({
        title: false,
        answer: false,
      });
    });

    it("drops a document after a direct document membership is revoked", async () => {
      const { owner, reader, doc } = await privateSetup();
      const membership = await UserMembership.create({
        createdById: owner.id,
        documentId: doc.id,
        userId: reader.id,
        permission: DocumentPermission.Read,
      });
      expect((await carriesForward(reader, doc)).answer).toEqual(true);
      await membership.destroy();
      expect(await carriesForward(reader, doc)).toEqual({
        title: false,
        answer: false,
      });
    });

    it("drops a document after a group membership is revoked", async () => {
      const { team, owner, reader, collection, doc } = await privateSetup();
      const group = await buildGroup({ teamId: team.id, userId: owner.id });
      await buildGroupUser({
        teamId: team.id,
        groupId: group.id,
        userId: reader.id,
      });
      const membership = await GroupMembership.create({
        createdById: owner.id,
        collectionId: collection.id,
        groupId: group.id,
        permission: CollectionPermission.Read,
      });
      expect((await carriesForward(reader, doc)).answer).toEqual(true);
      await membership.destroy();
      expect(await carriesForward(reader, doc)).toEqual({
        title: false,
        answer: false,
      });
    });

    it("treats documents as unreadable for a guest without membership", async () => {
      const { team, boss } = await setupScripted();
      const guest = await buildGuestUser({ teamId: team.id });
      expect(await carriesForward(guest, boss)).toEqual({
        title: false,
        answer: false,
      });
    });

    it("treats a cited document from another team as unreadable", async () => {
      const { reader } = await setupScripted();
      const { doc } = await privateSetup();
      const otherTeamPublic = await buildDocument({ title: "Foreign doc" });
      expect(await carriesForward(reader, doc)).toEqual({
        title: false,
        answer: false,
      });
      expect(await carriesForward(reader, otherTeamPublic)).toEqual({
        title: false,
        answer: false,
      });
    });
  });
});
