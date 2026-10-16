import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import Redis from "@server/storage/redis";
import {
  buildCollection,
  buildDocument,
  buildTeam,
  buildUser,
} from "@server/test/factories";
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
  type ConversationTurn,
} from "./conversation";
import { retrieveSources } from "./retrieve";

function key(teamId: string, userId: string, id: string) {
  return `aiconv:${teamId}:${userId}:${id}`;
}

function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    question: "What is BOSS API?",
    answer: "BOSS API is the booking service.",
    citedDocumentIds: [],
    at: Date.now(),
    ...overrides,
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
  await appendTurn(reader, created.id, {
    question: "What is BOSS API?",
    answer: "The BOSS API books rooms for guests.",
    citedDocumentIds: [boss.id],
    at: Date.now(),
  });
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

  it("never drops the newest question even when it alone exceeds the budget", async () => {
    const { user } = await setupUser();
    const id = (await createConversation(user))?.id ?? "";
    await appendTurn(user, id, turn({ question: "Q1" }));
    const huge = "q".repeat(30_000);
    await appendTurn(user, id, turn({ question: huge, answer: null }));
    const turns = (await loadConversation(user, id)).conversation?.turns ?? [];
    expect(turns.map((t) => t.question)).toEqual([huge]);
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

  it("drops the title and prior answer after access is revoked", async () => {
    const { reader, collection, conversation } = await setupScripted();
    await collection.update({ permission: null });

    const query = await buildStandaloneQuery(
      reader,
      conversation,
      "How does that relate to sync?"
    );
    expect(titleMentions(query)).toEqual(0);
    expect(await historyForModel(reader, conversation)).toEqual([
      { question: "What is BOSS API?", answer: null },
    ]);
  });

  it("drops the title and prior answer after the document is deleted", async () => {
    const { reader, boss, conversation } = await setupScripted();
    await boss.destroy();

    const query = await buildStandaloneQuery(reader, conversation, "Why?");
    expect(titleMentions(query)).toEqual(0);
    expect((await historyForModel(reader, conversation))[0].answer).toBeNull();
  });

  it("drops the title and prior answer once the collection is excluded from AI", async () => {
    const { reader, collection, conversation } = await setupScripted();
    await collection.update({ aiExcluded: true });

    const query = await buildStandaloneQuery(
      reader,
      conversation,
      "How does that relate to sync?"
    );
    expect(titleMentions(query)).toEqual(0);
    expect((await historyForModel(reader, conversation))[0].answer).toBeNull();
  });

  it("omits the answer when only some of its cited documents remain readable", async () => {
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
    expect(titleMentions(query)).toEqual(1);
    expect(query).not.toContain("Secret plan");
    expect((await historyForModel(reader, mixed))[0].answer).toBeNull();
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
});
