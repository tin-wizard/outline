import { subDays } from "date-fns";
import { AIConversation, AIConversationTurn } from "@server/models";
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
});
