import { buildTeam, buildUser } from "@server/test/factories";
import { buildPagesSite } from "plugins/pages-gate/server/test/factories";
import {
  PagesDomain,
  PagesInsight,
  PagesPublication,
  PagesSite,
  PagesViewEvent,
} from "@server/models";
import { randomString } from "@shared/random";

describe("PagesSite", () => {
  it("applies defaults on create", async () => {
    const site = await buildPagesSite();
    expect(site.status).toBe("draft");
    expect(site.gateType).toBe("code");
    expect(site.currentVersion).toBe(0);
    expect(site.codeVersion).toBe(0);
    expect(site.measurementEnabled).toBe(false);
    expect(site.rotatedAt).toBeNull();
  });

  it("rejects a duplicate slug", async () => {
    const site = await buildPagesSite();
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    await expect(
      PagesSite.create({
        teamId: team.id,
        createdById: user.id,
        slug: site.slug,
        title: "Other",
        prefix: `sites/${site.slug}/`,
      })
    ).rejects.toThrow();
  });

  it("generates a unique url-safe ingestKey not derived from the slug", async () => {
    const a = await buildPagesSite({
      slug: `a-${randomString(8).toLowerCase()}`,
    });
    const b = await buildPagesSite({
      slug: `b-${randomString(8).toLowerCase()}`,
    });
    expect(a.ingestKey).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(a.ingestKey).not.toEqual(b.ingestKey);
    expect(a.ingestKey).not.toContain(a.slug);
  });

  it("cascades deletion to publications, domains, events and insights", async () => {
    const site = await buildPagesSite();
    const now = new Date();
    await PagesPublication.create({
      siteId: site.id,
      sourceType: "document" as never,
      sourceId: site.id,
      pageKey: "index.html",
      contentHash: "abc",
      objectKey: `${site.prefix}index.html`,
      publishedAt: now,
    });
    await PagesDomain.create({
      siteId: site.id,
      hostname: `${randomString(8).toLowerCase()}.example.com`,
    });
    await PagesViewEvent.create({
      siteId: site.id,
      pageKey: "index.html",
      sessionId: "s1",
      startedAt: now,
      lastSeenAt: now,
    });
    await PagesInsight.create({
      siteId: site.id,
      pageKey: "",
      date: "2026-10-13",
      period: "day" as never,
    });

    await site.destroy();

    const where = { siteId: site.id };
    expect(await PagesPublication.count({ where })).toBe(0);
    expect(await PagesDomain.count({ where })).toBe(0);
    expect(await PagesViewEvent.count({ where })).toBe(0);
    expect(await PagesInsight.count({ where })).toBe(0);
  });
});
