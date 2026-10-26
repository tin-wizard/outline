"use strict";

const TURN_COLUMNS = [
  // Ids only; names are resolved for the reader when shown.
  ["scope", "JSONB"],
  ["totalMs", "INTEGER"],
  ["firstBlockMs", "INTEGER"],
  ["retrievalFetched", "SMALLINT"],
  ["retrievalUsed", "SMALLINT"],
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Fail fast rather than queue behind a long transaction.
      await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", {
        transaction,
      });
      for (const [name, type] of TURN_COLUMNS) {
        await queryInterface.addColumn(
          "ai_conversation_turns",
          name,
          { type: Sequelize[type], allowNull: true },
          { transaction }
        );
      }
      await queryInterface.addColumn(
        "ai_answer_usages",
        "feedbackReason",
        { type: Sequelize.TEXT, allowNull: true },
        { transaction }
      );
      // Redacted before it is written.
      await queryInterface.addColumn(
        "ai_answer_usages",
        "feedbackComment",
        { type: Sequelize.TEXT, allowNull: true },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE "ai_answer_usages"
           ADD CONSTRAINT "ai_answer_usages_feedback_reason_check"
           CHECK ("feedbackReason" IN ('inaccurate', 'incomplete', 'outdated', 'off_topic', 'other')),
           ADD CONSTRAINT "ai_answer_usages_feedback_comment_check"
           CHECK (char_length("feedbackComment") <= 500)`,
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", {
        transaction,
      });
      await queryInterface.sequelize.query(
        `ALTER TABLE "ai_answer_usages"
           DROP CONSTRAINT "ai_answer_usages_feedback_comment_check",
           DROP CONSTRAINT "ai_answer_usages_feedback_reason_check"`,
        { transaction }
      );
      await queryInterface.removeColumn("ai_answer_usages", "feedbackComment", {
        transaction,
      });
      await queryInterface.removeColumn("ai_answer_usages", "feedbackReason", {
        transaction,
      });
      for (const [name] of [...TURN_COLUMNS].reverse()) {
        await queryInterface.removeColumn("ai_conversation_turns", name, {
          transaction,
        });
      }
    });
  },
};
