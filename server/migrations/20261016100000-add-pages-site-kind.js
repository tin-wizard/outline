"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("pages_sites", "kind", {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: "pages",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("pages_sites", "kind");
  },
};
