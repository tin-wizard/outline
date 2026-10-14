"use strict";

const id = (Sequelize) => ({
  type: Sequelize.UUID,
  allowNull: false,
  defaultValue: Sequelize.UUIDV4,
  primaryKey: true,
});

const reference = (Sequelize, model, { allowNull = false, onDelete } = {}) => ({
  type: Sequelize.UUID,
  allowNull,
  references: { model, key: "id" },
  ...(onDelete ? { onDelete } : {}),
});

const timestamps = (Sequelize) => ({
  createdAt: { type: Sequelize.DATE, allowNull: false },
  updatedAt: { type: Sequelize.DATE, allowNull: false },
});

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "pages_sites",
        {
          id: id(Sequelize),
          teamId: reference(Sequelize, "teams", { onDelete: "CASCADE" }),
          slug: { type: Sequelize.STRING, allowNull: false, unique: true },
          title: { type: Sequelize.STRING, allowNull: false },
          status: {
            type: Sequelize.STRING,
            allowNull: false,
            defaultValue: "draft",
          },
          gateType: {
            type: Sequelize.STRING,
            allowNull: false,
            defaultValue: "code",
          },
          prefix: { type: Sequelize.STRING, allowNull: false },
          currentVersion: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          codeVersion: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          rotatedAt: { type: Sequelize.DATE, allowNull: true },
          rotatedById: reference(Sequelize, "users", {
            allowNull: true,
            onDelete: "SET NULL",
          }),
          measurementEnabled: {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
          },
          ingestKey: { type: Sequelize.STRING, allowNull: false, unique: true },
          createdById: reference(Sequelize, "users"),
          ...timestamps(Sequelize),
        },
        { transaction }
      );
      await queryInterface.addIndex("pages_sites", ["teamId"], { transaction });

      await queryInterface.createTable(
        "pages_publications",
        {
          id: id(Sequelize),
          siteId: reference(Sequelize, "pages_sites", { onDelete: "CASCADE" }),
          sourceType: { type: Sequelize.STRING, allowNull: false },
          sourceId: { type: Sequelize.UUID, allowNull: false },
          pageKey: { type: Sequelize.STRING(512), allowNull: false },
          contentHash: { type: Sequelize.STRING, allowNull: false },
          objectKey: { type: Sequelize.STRING(512), allowNull: false },
          title: { type: Sequelize.STRING(1024), allowNull: true },
          publishedAt: { type: Sequelize.DATE, allowNull: false },
          publishedById: reference(Sequelize, "users", {
            allowNull: true,
            onDelete: "SET NULL",
          }),
          ...timestamps(Sequelize),
        },
        { transaction }
      );
      await queryInterface.addIndex(
        "pages_publications",
        ["siteId", "pageKey"],
        { unique: true, transaction }
      );

      await queryInterface.createTable(
        "pages_domains",
        {
          id: id(Sequelize),
          siteId: reference(Sequelize, "pages_sites", { onDelete: "CASCADE" }),
          hostname: { type: Sequelize.STRING, allowNull: false, unique: true },
          verificationStatus: {
            type: Sequelize.STRING,
            allowNull: false,
            defaultValue: "pending",
          },
          certificateStatus: {
            type: Sequelize.STRING,
            allowNull: false,
            defaultValue: "pending",
          },
          activatedAt: { type: Sequelize.DATE, allowNull: true },
          ...timestamps(Sequelize),
        },
        { transaction }
      );
      await queryInterface.addIndex("pages_domains", ["siteId"], {
        transaction,
      });
      // Enforced in the database so bulk writes and raw SQL cannot bypass the
      // model hook and let two rows claim the same domain in different case.
      await queryInterface.sequelize.query(
        `ALTER TABLE pages_domains
           ADD CONSTRAINT pages_domains_hostname_lowercase
           CHECK (hostname = lower(hostname))`,
        { transaction }
      );

      await queryInterface.createTable(
        "pages_view_events",
        {
          id: id(Sequelize),
          siteId: reference(Sequelize, "pages_sites", { onDelete: "CASCADE" }),
          pageKey: { type: Sequelize.STRING(512), allowNull: false },
          sessionId: { type: Sequelize.STRING, allowNull: false },
          startedAt: { type: Sequelize.DATE, allowNull: false },
          lastSeenAt: { type: Sequelize.DATE, allowNull: false },
          activeSeconds: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          referrerDomain: { type: Sequelize.STRING, allowNull: true },
          country: { type: Sequelize.STRING(2), allowNull: true },
          ...timestamps(Sequelize),
        },
        { transaction }
      );
      await queryInterface.addIndex(
        "pages_view_events",
        ["siteId", "sessionId", "pageKey", "startedAt"],
        { unique: true, transaction }
      );
      await queryInterface.addIndex(
        "pages_view_events",
        ["siteId", "startedAt"],
        { transaction }
      );

      await queryInterface.createTable(
        "pages_insights",
        {
          id: id(Sequelize),
          siteId: reference(Sequelize, "pages_sites", { onDelete: "CASCADE" }),
          pageKey: { type: Sequelize.STRING(512), allowNull: false },
          date: { type: Sequelize.DATEONLY, allowNull: false },
          period: { type: Sequelize.STRING, allowNull: false },
          viewCount: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          visitorCount: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          totalActiveSeconds: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          timeHistogram: {
            type: Sequelize.JSONB,
            allowNull: false,
            defaultValue: {},
          },
          ...timestamps(Sequelize),
        },
        { transaction }
      );
      await queryInterface.addIndex(
        "pages_insights",
        ["siteId", "pageKey", "date", "period"],
        { unique: true, transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Children first; their foreign keys point at pages_sites.
      for (const table of [
        "pages_insights",
        "pages_view_events",
        "pages_domains",
        "pages_publications",
        "pages_sites",
      ]) {
        await queryInterface.dropTable(table, { transaction });
      }
    });
  },
};
