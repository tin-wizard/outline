"use strict";

// Same policy as 20261016130000-create-ai-answer-usages.js, including the
// nullif() variant: a pooled connection reports '' for these settings after a
// transaction that used SET LOCAL, and ''::boolean would raise.
const POLICY_EXPRESSION = `
  NOT coalesce(nullif(current_setting('app.rls_forced', true), ''), 'off')::boolean
  OR coalesce(nullif(current_setting('app.is_platform_admin', true), ''), 'off')::boolean
  OR "teamId"::text = nullif(current_setting('app.team_id', true), '')
`;

const TABLES = ["ai_conversations", "ai_conversation_turns"];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(`SET LOCAL lock_timeout = '5s';`, {
        transaction,
      });

      await queryInterface.createTable(
        "ai_conversations",
        {
          id: { type: Sequelize.UUID, allowNull: false, primaryKey: true },
          teamId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "teams", key: "id" },
            onDelete: "CASCADE",
          },
          userId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "users", key: "id" },
            onDelete: "CASCADE",
          },
          title: { type: Sequelize.STRING, allowNull: false },
          pinnedAt: { type: Sequelize.DATE, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false },
          updatedAt: { type: Sequelize.DATE, allowNull: false },
          // Reserved; conversations are hard deleted today.
          deletedAt: { type: Sequelize.DATE, allowNull: true },
        },
        { transaction }
      );
      await queryInterface.addIndex(
        "ai_conversations",
        ["teamId", "userId", { name: "updatedAt", order: "DESC" }],
        { name: "ai_conversations_team_user_updated_at", transaction }
      );

      await queryInterface.createTable(
        "ai_conversation_turns",
        {
          id: { type: Sequelize.UUID, allowNull: false, primaryKey: true },
          conversationId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "ai_conversations", key: "id" },
            onDelete: "CASCADE",
          },
          teamId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "teams", key: "id" },
            onDelete: "CASCADE",
          },
          userId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "users", key: "id" },
            onDelete: "CASCADE",
          },
          position: { type: Sequelize.INTEGER, allowNull: false },
          question: { type: Sequelize.TEXT, allowNull: false },
          blocks: {
            type: Sequelize.JSONB,
            allowNull: false,
            defaultValue: [],
          },
          citedDocumentIds: {
            type: Sequelize.ARRAY(Sequelize.UUID),
            allowNull: false,
            defaultValue: [],
          },
          outcome: { type: Sequelize.TEXT, allowNull: false },
          usageId: { type: Sequelize.UUID, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false },
        },
        { transaction }
      );
      await queryInterface.addIndex(
        "ai_conversation_turns",
        ["conversationId", "position"],
        {
          name: "ai_conversation_turns_conversation_position",
          unique: true,
          transaction,
        }
      );

      for (const table of TABLES) {
        await queryInterface.sequelize.query(
          `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;\n` +
            `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
          { transaction }
        );
        await queryInterface.sequelize.query(
          `CREATE POLICY tenant_isolation ON "${table}"\n` +
            `  AS PERMISSIVE\n` +
            `  FOR ALL\n` +
            `  TO PUBLIC\n` +
            `  USING (${POLICY_EXPRESSION})\n` +
            `  WITH CHECK (${POLICY_EXPRESSION});`,
          { transaction }
        );
      }
    });
  },

  async down(queryInterface) {
    // Dropping the tables removes their policies and indexes.
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(`SET LOCAL lock_timeout = '5s';`, {
        transaction,
      });
      await queryInterface.dropTable("ai_conversation_turns", { transaction });
      await queryInterface.dropTable("ai_conversations", { transaction });
    });
  },
};
