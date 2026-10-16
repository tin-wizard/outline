"use strict";

// Same predicate as 20260910000000-enable-rls-team-scoped-tables.js: enforced
// only inside authenticated API transactions, exempt elsewhere (workers). One
// deliberate difference: nullif() treats the empty string as unset. After any
// transaction that used SET LOCAL, a pooled connection reports '' for these
// settings, and ''::boolean raises, which would break every plain query.
const POLICY_EXPRESSION = `
  NOT coalesce(nullif(current_setting('app.rls_forced', true), ''), 'off')::boolean
  OR coalesce(nullif(current_setting('app.is_platform_admin', true), ''), 'off')::boolean
  OR "teamId"::text = nullif(current_setting('app.team_id', true), '')
`;

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "ai_answer_usages",
        {
          id: {
            type: Sequelize.UUID,
            allowNull: false,
            primaryKey: true,
          },
          teamId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "teams", key: "id" },
            onDelete: "CASCADE",
          },
          userId: {
            type: Sequelize.UUID,
            allowNull: true,
            references: { model: "users", key: "id" },
            onDelete: "SET NULL",
          },
          model: { type: Sequelize.STRING, allowNull: false },
          inputTokens: { type: Sequelize.INTEGER, allowNull: false },
          outputTokens: { type: Sequelize.INTEGER, allowNull: false },
          // Integer micro-dollars (1e-6 USD) so sums never drift.
          costMicroUsd: { type: Sequelize.BIGINT, allowNull: false },
          outcome: { type: Sequelize.TEXT, allowNull: false },
          droppedSegments: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          durationMs: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          createdAt: { type: Sequelize.DATE, allowNull: false },
        },
        { transaction }
      );

      await queryInterface.addIndex(
        "ai_answer_usages",
        ["teamId", "createdAt"],
        {
          transaction,
        }
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE "ai_answer_usages" ENABLE ROW LEVEL SECURITY;\n` +
          `ALTER TABLE "ai_answer_usages" FORCE ROW LEVEL SECURITY;`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE POLICY tenant_isolation ON "ai_answer_usages"\n` +
          `  AS PERMISSIVE\n` +
          `  FOR ALL\n` +
          `  TO PUBLIC\n` +
          `  USING (${POLICY_EXPRESSION})\n` +
          `  WITH CHECK (${POLICY_EXPRESSION});`,
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    // Dropping the table removes its policy and indexes.
    await queryInterface.dropTable("ai_answer_usages");
  },
};
