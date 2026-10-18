import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { TeamPreference } from "@shared/types";
import Logger from "@server/logging/Logger";
import { AIConversation, AIConversationTurn, Team } from "@server/models";
import type { User } from "@server/models";
import {
  buildCollection,
  buildDocument,
  buildUser,
} from "@server/test/factories";
import { splitBlocks } from "./blocks";
import {
  DEFAULT_RETENTION_DAYS,
  MAX_STORED_TURNS,
  appendConversationTurn,
  conversationTitle,
  getConversationForResume,
  retentionDays,
} from "./history";
import type { AcceptedBlock } from "./verify";

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

function released(
  text: string,
  documentIds: string[],
  heading?: string
): AcceptedBlock {
  return {
    ok: true,
    block: splitBlocks(text)[0],
    citations: documentIds.map((documentId) => ({
      documentId,
      title: "stored titles are ignored",
      url: "/doc/ignored",
      quote: "a supporting quote",
      ...(heading ? { heading } : {}),
    })),
    modelCited: documentIds.length > 0,
  };
}

describe("retentionDays", () => {
  it.each([
    [undefined, DEFAULT_RETENTION_DAYS],
    ["", DEFAULT_RETENTION_DAYS],
    ["abc", DEFAULT_RETENTION_DAYS],
    ["12.5", DEFAULT_RETENTION_DAYS],
    ["-5", DEFAULT_RETENTION_DAYS],
    ["30", 30],
    [" 45 ", 45],
    ["0", 1],
    ["1000", 365],
  ])("parses %j as %d", (value, expected) => {
    expect(retentionDays(value)).toEqual(expected);
  });
});

describe("conversationTitle", () => {
  it("collapses whitespace, redacts and caps at 80 characters", () => {
    expect(conversationTitle("  What   is\nBOSS?  ")).toEqual("What is BOSS?");
    expect(conversationTitle(`key ${secret}`)).not.toContain(secret);
    expect([...conversationTitle("x".repeat(200))]).toHaveLength(80);
  });
});

describe("appendConversationTurn", () => {
  it("creates a conversation on the first turn and appends later turns", async () => {
    const user = await enable(await buildUser());
    const doc = await buildDocument({ teamId: user.teamId, userId: user.id });

    const id = await appendConversationTurn(user, {
      question: `What is BOSS? ${secret}`,
      released: [
        released("BOSS API is the booking service.", [doc.id], "Intro"),
      ],
      outcome: "answered",
      usageId: null,
    });
    expect(id).toEqual(expect.any(String));

    const conversation = await AIConversation.findByPk(id!, {
      rejectOnEmpty: true,
    });
    expect(conversation.userId).toEqual(user.id);
    expect(conversation.teamId).toEqual(user.teamId);
    expect(conversation.title).not.toContain(secret);
    expect(conversation.title.startsWith("What is BOSS?")).toBe(true);
    const firstUpdatedAt = conversation.updatedAt;

    const [turn] = await AIConversationTurn.findAll({
      where: { conversationId: id! },
    });
    expect(turn.position).toEqual(0);
    expect(turn.question).not.toContain(secret);
    expect(turn.outcome).toEqual("answered");
    expect(turn.citedDocumentIds).toEqual([doc.id]);
    expect(turn.blocks).toEqual([
      {
        kind: "paragraph",
        markdown: "BOSS API is the booking service.",
        citations: [{ documentId: doc.id, quote: "a supporting quote" }],
      },
    ]);

    const usageId = randomUUID();
    const again = await appendConversationTurn(user, {
      conversationId: id!,
      question: "And then?",
      released: [],
      outcome: "no_answer",
      usageId,
    });
    expect(again).toEqual(id);
    const turns = await AIConversationTurn.findAll({
      where: { conversationId: id! },
      order: [["position", "ASC"]],
    });
    expect(turns.map((t) => t.position)).toEqual([0, 1]);
    expect(turns[1].blocks).toEqual([]);
    expect(turns[1].usageId).toEqual(usageId);
    await conversation.reload();
    expect(conversation.updatedAt.getTime()).toBeGreaterThanOrEqual(
      firstUpdatedAt.getTime()
    );
  });

  it("creates the conversation with the given id only when asked to", async () => {
    const user = await enable(await buildUser());
    const conversationId = randomUUID();
    const turn = {
      conversationId,
      question: "Hello?",
      released: [],
      outcome: "no_answer",
      usageId: null,
    };
    expect(await appendConversationTurn(user, turn)).toBeNull();
    expect(await AIConversation.findByPk(conversationId)).toBeNull();
    expect(
      await appendConversationTurn(user, { ...turn, create: true })
    ).toEqual(conversationId);
    // Allowed to create, but it exists: the turn is appended.
    expect(
      await appendConversationTurn(user, {
        ...turn,
        create: true,
        title: "Ignored for an existing conversation",
        droppedSegments: 2,
      })
    ).toEqual(conversationId);
    const turns = await AIConversationTurn.findAll({
      where: { conversationId },
      order: [["position", "ASC"]],
    });
    expect(turns.map((t) => [t.position, t.droppedSegments])).toEqual([
      [0, 0],
      [1, 2],
    ]);
    const conversation = await AIConversation.findByPk(conversationId, {
      rejectOnEmpty: true,
    });
    expect(conversation.title).toEqual("Hello?");
  });

  it("titles a new conversation from the given first question, redacted", async () => {
    const user = await enable(await buildUser());
    const id = await appendConversationTurn(user, {
      conversationId: randomUUID(),
      create: true,
      title: `First question ${secret}`,
      question: "Second question",
      released: [],
      outcome: "no_answer",
      usageId: null,
    });
    const conversation = await AIConversation.findByPk(id!, {
      rejectOnEmpty: true,
    });
    expect(conversation.title.startsWith("First question")).toBe(true);
    expect(conversation.title).not.toContain(secret);
  });

  it("never resurrects a deleted conversation", async () => {
    const user = await enable(await buildUser());
    const id = await appendConversationTurn(user, {
      question: "First?",
      released: [],
      outcome: "no_answer",
      usageId: null,
    });
    await AIConversation.destroy({ where: { id: id! } });
    expect(
      await appendConversationTurn(user, {
        conversationId: id,
        question: "Late turn",
        released: [],
        outcome: "no_answer",
        usageId: null,
      })
    ).toBeNull();
    expect(await AIConversation.findByPk(id!)).toBeNull();
    expect(
      await AIConversationTurn.count({ where: { conversationId: id! } })
    ).toEqual(0);
  });

  it("never writes into another user's conversation", async () => {
    const owner = await enable(await buildUser());
    const other = await enable(await buildUser({ teamId: owner.teamId }));
    const id = await appendConversationTurn(owner, {
      question: "Mine",
      released: [],
      outcome: "no_answer",
      usageId: null,
    });
    for (const create of [false, true]) {
      const result = await appendConversationTurn(other, {
        conversationId: id!,
        create,
        question: "Intruder",
        released: [],
        outcome: "no_answer",
        usageId: null,
      });
      expect(result).toBeNull();
    }
    expect(
      await AIConversationTurn.count({ where: { conversationId: id! } })
    ).toEqual(1);
  });

  it("stores nothing when history is off", async () => {
    const user = await enable(await buildUser(), false);
    expect(
      await appendConversationTurn(user, {
        question: "Hello?",
        released: [],
        outcome: "no_answer",
        usageId: null,
      })
    ).toBeNull();
    expect(await AIConversation.count({ where: { userId: user.id } })).toEqual(
      0
    );
  });

  it("drops an answer that is too long to store", async () => {
    const user = await enable(await buildUser());
    const doc = await buildDocument({ teamId: user.teamId, userId: user.id });
    const id = await appendConversationTurn(user, {
      question: "Long?",
      released: [released("word ".repeat(4000), [doc.id])],
      outcome: "answered",
      usageId: null,
    });
    const turn = await AIConversationTurn.findOne({
      where: { conversationId: id! },
      rejectOnEmpty: true,
    });
    expect(turn.blocks).toEqual([]);
    expect(turn.citedDocumentIds).toEqual([]);
  });

  it("refuses more than the maximum number of turns", async () => {
    const user = await enable(await buildUser());
    const conversation = await AIConversation.create({
      teamId: user.teamId,
      userId: user.id,
      title: "Full",
    });
    await AIConversationTurn.bulkCreate(
      Array.from({ length: MAX_STORED_TURNS }, (_, position) => ({
        conversationId: conversation.id,
        teamId: user.teamId,
        userId: user.id,
        position,
        question: "q",
        blocks: [],
        citedDocumentIds: [],
        outcome: "no_answer",
      }))
    );
    expect(
      await appendConversationTurn(user, {
        conversationId: conversation.id,
        question: "One more",
        released: [],
        outcome: "no_answer",
        usageId: null,
      })
    ).toBeNull();
  });

  it("stores a url-safe citation anchor and drops an unsafe one", async () => {
    const user = await enable(await buildUser());
    const block = released("BOSS API is the booking service.", [randomUUID()]);
    const [citation] = block.citations;
    const id = await appendConversationTurn(user, {
      question: "Anchors?",
      released: [
        {
          ...block,
          citations: [
            { ...citation, headingText: "Intro", anchor: "h-intro-2" },
            { ...citation, anchor: 'h-x"><script>' },
            { ...citation, anchor: "h-cafe-🎉-uberblick-1" },
          ],
        },
      ],
      outcome: "answered",
      usageId: null,
    });
    const [turn] = await AIConversationTurn.findAll({
      where: { conversationId: id! },
    });
    expect(turn.blocks[0].citations).toEqual([
      {
        documentId: citation.documentId,
        quote: "a supporting quote",
        heading: "Intro",
        anchor: "h-intro-2",
      },
      { documentId: citation.documentId, quote: "a supporting quote" },
      {
        documentId: citation.documentId,
        quote: "a supporting quote",
        anchor: "h-cafe-🎉-uberblick-1",
      },
    ]);
  });

  it("keeps positions consistent when turns of a conversation are stored at once", async () => {
    const user = await enable(await buildUser());
    const conversationId = randomUUID();
    await appendConversationTurn(user, {
      conversationId,
      create: true,
      question: "Zero?",
      released: [],
      outcome: "no_answer",
      usageId: null,
    });
    // Hold each transaction open after it locked the conversation, so the
    // others start before it commits.
    const create = AIConversationTurn.create.bind(AIConversationTurn);
    vi.spyOn(AIConversationTurn, "create").mockImplementation(
      async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return create(...args);
      }
    );
    const results = await Promise.all(
      ["One?", "Two?", "Three?"].map((question) =>
        appendConversationTurn(user, {
          conversationId,
          question,
          released: [],
          outcome: "no_answer",
          usageId: null,
        })
      )
    );
    vi.restoreAllMocks();
    expect(results).toEqual([conversationId, conversationId, conversationId]);
    const turns = await AIConversationTurn.findAll({
      where: { conversationId },
      order: [["position", "ASC"]],
    });
    expect(turns.map((t) => t.position)).toEqual([0, 1, 2, 3]);
    expect(
      await AIConversation.count({ where: { id: conversationId } })
    ).toEqual(1);
  });

  it("returns null and logs no content when storing fails", async () => {
    const user = await enable(await buildUser());
    const warn = vi.spyOn(Logger, "warn");
    vi.spyOn(AIConversation, "create").mockRejectedValueOnce(
      new Error(`boom ${secret}`)
    );
    expect(
      await appendConversationTurn(user, {
        question: `Secret question ${secret}`,
        released: [],
        outcome: "no_answer",
        usageId: null,
      })
    ).toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Secret question");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    vi.restoreAllMocks();
  });
});

describe("getConversationForResume", () => {
  it("returns re-authorised turns for the owner only", async () => {
    const user = await enable(await buildUser());
    const collection = await buildCollection({
      teamId: user.teamId,
      userId: user.id,
    });
    const kept = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
      collectionId: collection.id,
    });
    const revoked = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
      collectionId: collection.id,
    });
    const id = await appendConversationTurn(user, {
      question: "First?",
      released: [released("Kept answer text here.", [kept.id])],
      outcome: "answered",
      usageId: null,
    });
    await appendConversationTurn(user, {
      conversationId: id!,
      question: "Second?",
      released: [released("Revoked answer text.", [revoked.id])],
      outcome: "answered",
      usageId: null,
    });
    await revoked.destroy();

    const resumed = await getConversationForResume(user, id!);
    expect(resumed?.id).toEqual(id);
    expect(resumed?.turns.map((t) => [t.question, t.answer])).toEqual([
      ["First?", "Kept answer text here."],
      ["Second?", null],
    ]);

    const other = await enable(await buildUser({ teamId: user.teamId }));
    expect(await getConversationForResume(other, id!)).toBeNull();
    expect(await getConversationForResume(user, "not-a-uuid")).toBeNull();
  });
});
