"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Fail fast rather than queue behind a long transaction and block every
      // query on the collections table.
      await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", {
        transaction,
      });
      await queryInterface.addColumn(
        "collections",
        "aiExcluded",
        {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn("collections", "aiExcluded", {
        transaction,
      });
    });
  },
};
