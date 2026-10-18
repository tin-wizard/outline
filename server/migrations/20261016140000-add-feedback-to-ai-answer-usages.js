"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Fail fast rather than queue behind a long transaction.
      await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", {
        transaction,
      });
      // -1 = not helpful, 1 = helpful, NULL = no rating. Never any text.
      await queryInterface.addColumn(
        "ai_answer_usages",
        "feedback",
        { type: Sequelize.SMALLINT, allowNull: true },
        { transaction }
      );
      await queryInterface.addColumn(
        "ai_answer_usages",
        "feedbackAt",
        { type: Sequelize.DATE, allowNull: true },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE "ai_answer_usages"
           ADD CONSTRAINT "ai_answer_usages_feedback_check"
           CHECK ("feedback" IN (-1, 1))`,
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `ALTER TABLE "ai_answer_usages"
           DROP CONSTRAINT "ai_answer_usages_feedback_check"`,
        { transaction }
      );
      await queryInterface.removeColumn("ai_answer_usages", "feedbackAt", {
        transaction,
      });
      await queryInterface.removeColumn("ai_answer_usages", "feedback", {
        transaction,
      });
    });
  },
};
