import { subDays } from "date-fns";
import {
  AIAnswerUsage,
  AIConversation,
  AIConversationTurn,
} from "@server/models";
import { sequelize } from "@server/storage/database";
import { buildUser } from "@server/test/factories";
import CleanupOldAIConversationsTask from "./CleanupOldAIConversationsTask";

async function buildConversation(userId: string, teamId: string, at: Date) {
  const conversation = await AIConversation.create({
    teamId,
    userId,
    title: "t",
  });
  await AIConversationTurn.create({
    conversationId: conversation.id,
    teamId,
    userId,
    position: 0,
    question: "q",
    blocks: [],
    citedDocumentIds: [],
    outcome: "no_answer",
  });
  // Set the activity time directly; Sequelize would overwrite updatedAt.
  await sequelize.query(
    `UPDATE "ai_conversations" SET "updatedAt" = :at WHERE "id" = :id`,
    { replacements: { at, id: conversation.id } }
  );
  return conversation;
}

describe("CleanupOldAIConversationsTask", () => {
  it("deletes conversations inactive for longer than the retention period", async () => {
    const user = await buildUser();
    const old = await buildConversation(
      user.id,
      user.teamId,
      subDays(new Date(), 91)
    );
    const recent = await buildConversation(
      user.id,
      user.teamId,
      subDays(new Date(), 89)
    );

    await new CleanupOldAIConversationsTask().perform({
      limit: 10000,
      partition: { partitionIndex: 0, partitionCount: 1 },
    });

    expect(await AIConversation.findByPk(old.id)).toBeNull();
    expect(
      await AIConversationTurn.count({ where: { conversationId: old.id } })
    ).toEqual(0);
    expect(await AIConversation.findByPk(recent.id)).not.toBeNull();
  });

  it("clears feedback comments older than the retention period, keeping the rest of the row", async () => {
    const [user, outsider] = [await buildUser(), await buildUser()];
    const usage = async (userId: string, teamId: string, days: number) => {
      const row = await AIAnswerUsage.create({
        teamId,
        userId,
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
        costMicroUsd: "5",
        outcome: "answered",
        droppedSegments: 0,
        durationMs: 1,
        feedback: -1,
        feedbackAt: new Date(),
        feedbackReason: "outdated",
        feedbackComment: "Old text",
      });
      await sequelize.query(
        `UPDATE "ai_answer_usages" SET "createdAt" = :at WHERE "id" = :id`,
        { replacements: { at: subDays(new Date(), days), id: row.id } }
      );
      return row;
    };
    const old = await usage(user.id, user.teamId, 91);
    const otherOld = await usage(outsider.id, outsider.teamId, 120);
    const recent = await usage(user.id, user.teamId, 89);

    await new CleanupOldAIConversationsTask().perform({
      limit: 10000,
      partition: { partitionIndex: 0, partitionCount: 1 },
    });

    for (const row of [old, otherOld]) {
      const saved = await AIAnswerUsage.findByPk(row.id, {
        rejectOnEmpty: true,
      });
      expect(saved.feedbackComment).toBeNull();
      expect(saved.feedbackReason).toEqual("outdated");
      expect(saved.feedback).toEqual(-1);
      expect(saved.costMicroUsd).toEqual("5");
    }
    const kept = await AIAnswerUsage.findByPk(recent.id, {
      rejectOnEmpty: true,
    });
    expect(kept.feedbackComment).toEqual("Old text");
  });
});
