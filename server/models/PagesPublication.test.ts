import { PagesPublication } from "@server/models";
import { sequelize } from "@server/storage/database";
import { PagesSourceType } from "./PagesPublication";
import { buildPagesSite } from "plugins/pages-gate/server/test/factories";

describe("PagesPublication", () => {
  it("is unique on (siteId, pageKey)", async () => {
    const site = await buildPagesSite();
    const attrs = {
      siteId: site.id,
      sourceType: PagesSourceType.Document,
      sourceId: site.id,
      pageKey: "index.html",
      contentHash: "abc",
      objectKey: `${site.prefix}index.html`,
      publishedAt: new Date(),
    };
    await PagesPublication.create(attrs);
    await expect(PagesPublication.create(attrs)).rejects.toThrow();
    await expect(
      PagesPublication.create({ ...attrs, pageKey: "other.html" })
    ).resolves.toBeDefined();
  });

  it("round-trips a 512-character page key and object key and a title", async () => {
    const site = await buildPagesSite();
    const pageKey = `${"a".repeat(507)}.html`;
    const objectKey = "o".repeat(512);
    const title = "T".repeat(1024);
    const created = await PagesPublication.create({
      siteId: site.id,
      sourceType: PagesSourceType.Document,
      sourceId: site.id,
      pageKey,
      contentHash: "abc",
      objectKey,
      title,
      publishedAt: new Date(),
    });

    const row = await PagesPublication.findByPk(created.id, {
      rejectOnEmpty: true,
    });
    expect(row.pageKey).toEqual(pageKey);
    expect(row.objectKey).toEqual(objectKey);
    expect(row.title).toEqual(title);
  });

  it("matches the migration's column widths in every pages table", async () => {
    const qi = sequelize.getQueryInterface();
    const publications = await qi.describeTable("pages_publications");
    expect(publications.pageKey.type).toEqual("CHARACTER VARYING(512)");
    expect(publications.objectKey.type).toEqual("CHARACTER VARYING(512)");
    expect(publications.title.type).toEqual("CHARACTER VARYING(1024)");
    expect(publications.title.allowNull).toBe(true);
    for (const table of ["pages_view_events", "pages_insights"]) {
      const columns = await qi.describeTable(table);
      expect(columns.pageKey.type).toEqual("CHARACTER VARYING(512)");
    }
  });
});
