import { randomString } from "@shared/random";
import { Scope } from "@shared/types";
import { PagesDomain, PagesSite } from "@server/models";
import {
  buildAdmin,
  buildApiKey,
  buildGuestUser,
  buildOAuthAuthentication,
  buildTeam,
  buildUser,
  buildViewer,
} from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import { buildPagesSite } from "../test/factories";

// The test setup loads every plugin entry point before this file runs, while
// PAGES_* is unset, so the plugin's index registers nothing. Mount the router
// here, before the API app is built by getTestServer(), exactly as index.ts
// does when the plugin is enabled.
await vi.hoisted(async () => {
  const { PluginManager, Hook } = await import("@server/utils/PluginManager");
  const { default: pages } = await import("./pages");
  PluginManager.add({ type: Hook.API, value: pages });
});

const server = getTestServer();

const uniqueSlug = () => `site-${randomString(10).toLowerCase()}`;

async function setup() {
  const team = await buildTeam();
  const admin = await buildAdmin({ teamId: team.id });
  const site = await buildPagesSite({
    teamId: team.id,
    createdById: admin.id,
  });
  return { team, admin, site };
}

function bodyFor(route: string, site: PagesSite) {
  switch (route) {
    case "pages.info":
      return { id: site.id };
    case "pages.update":
      return { id: site.id, title: "Changed" };
    case "pages.create":
      return { slug: uniqueSlug(), title: "New site" };
    default:
      return {};
  }
}

const ROUTES = ["pages.list", "pages.info", "pages.create", "pages.update"];

describe.each(ROUTES)("%s access", (route) => {
  it("refuses an unauthenticated request with 401", async () => {
    const { site } = await setup();
    const res = await server.post(`/api/${route}`, {
      body: bodyFor(route, site),
    });
    expect(res.status).toEqual(401);
  });

  it.each([
    ["member", buildUser],
    ["viewer", buildViewer],
    ["guest", buildGuestUser],
  ])("refuses a %s with 403", async (_role, build) => {
    const { team, site } = await setup();
    const user = await build({ teamId: team.id });
    const res = await server.post(`/api/${route}`, user, {
      body: bodyFor(route, site),
    });
    expect(res.status).toEqual(403);
  });

  it("allows an admin", async () => {
    const { admin, site } = await setup();
    const res = await server.post(`/api/${route}`, admin, {
      body: bodyFor(route, site),
    });
    expect(res.status).toEqual(200);
  });

  it("allows a platform admin without the admin role", async () => {
    const { team, site } = await setup();
    const platformAdmin = await buildUser({
      teamId: team.id,
      flags: { platformAdmin: 1 },
    });
    const res = await server.post(`/api/${route}`, platformAdmin, {
      body: bodyFor(route, site),
    });
    expect(res.status).toEqual(200);
  });

  it("refuses an admin's API key", async () => {
    const { admin, site } = await setup();
    const apiKey = await buildApiKey({ userId: admin.id });
    const res = await server.post(`/api/${route}`, {
      body: bodyFor(route, site),
      headers: { Authorization: `Bearer ${apiKey.value}` },
    });
    expect(res.status).toEqual(403);
  });
});

describe("OAuth access tokens", () => {
  it("refuses an admin's OAuth access token with 403", async () => {
    const { admin, site } = await setup();
    const authentication = await buildOAuthAuthentication({
      user: admin,
      scope: [Scope.Read, Scope.Write],
    });
    const headers = { Authorization: `Bearer ${authentication.accessToken}` };

    // The token itself is valid: a core route accepts it.
    const core = await server.post("/api/auth.info", { headers });
    expect(core.status).toEqual(200);

    const res = await server.post("/api/pages.info", {
      body: { id: site.id },
      headers,
    });
    expect(res.status).toEqual(403);
  });
});

describe("#pages.list", () => {
  it("returns only the team's sites, newest first", async () => {
    const { team, admin, site } = await setup();
    const newer = await buildPagesSite({
      teamId: team.id,
      createdById: admin.id,
      createdAt: new Date(Date.now() + 1000),
    });
    await buildPagesSite();

    const res = await server.post("/api/pages.list", admin);
    const body = await res.json();

    expect(res.status).toEqual(200);
    expect(body.data.map((s: { id: string }) => s.id)).toEqual([
      newer.id,
      site.id,
    ]);
    expect(body.pagination).toBeDefined();
  });

  it("filters by title or slug", async () => {
    const { team, admin } = await setup();
    const byTitle = await buildPagesSite({
      teamId: team.id,
      title: "Quarterly Report",
    });
    const slug = `quarterly-${randomString(8).toLowerCase()}`;
    const bySlug = await buildPagesSite({ teamId: team.id, slug });

    const res = await server.post("/api/pages.list", admin, {
      body: { query: "QUARTERLY" },
    });
    const body = await res.json();

    expect(res.status).toEqual(200);
    expect(body.data.map((s: { id: string }) => s.id).sort()).toEqual(
      [byTitle.id, bySlug.id].sort()
    );
  });

  it("treats LIKE wildcards in the query literally", async () => {
    const { admin } = await setup();
    const res = await server.post("/api/pages.list", admin, {
      body: { query: "%" },
    });
    const body = await res.json();
    expect(res.status).toEqual(200);
    expect(body.data).toEqual([]);
  });

  it("shows another team's admin none of this team's sites", async () => {
    const { site } = await setup();
    const outsider = await buildAdmin();

    const res = await server.post("/api/pages.list", outsider);
    const body = await res.json();

    expect(res.status).toEqual(200);
    expect(body.data.map((s: { id: string }) => s.id)).not.toContain(site.id);
    expect(body.data).toEqual([]);
  });
});

describe("#pages.info", () => {
  it("returns the presented site", async () => {
    const { admin, site } = await setup();
    await PagesDomain.create({ siteId: site.id, hostname: hostname() });

    const res = await server.post("/api/pages.info", admin, {
      body: { id: site.id },
    });
    const body = await res.json();

    expect(res.status).toEqual(200);
    expect(Object.keys(body.data).sort()).toEqual(
      [
        "codeVersion",
        "createdAt",
        "currentVersion",
        "domains",
        "gateType",
        "id",
        "ingestKey",
        "measurementEnabled",
        "pages",
        "publishedUrl",
        "rotatedAt",
        "slug",
        "status",
        "title",
        "updatedAt",
      ].sort()
    );
    expect(Object.keys(body.data.domains[0]).sort()).toEqual([
      "certificateStatus",
      "hostname",
      "verificationStatus",
    ]);
  });

  it("returns 404 to another team's admin", async () => {
    const { site } = await setup();
    const outsider = await buildAdmin();

    const res = await server.post("/api/pages.info", outsider, {
      body: { id: site.id },
    });
    expect(res.status).toEqual(404);
  });

  it("returns 404 to another team's platform admin", async () => {
    const { site } = await setup();
    const outsider = await buildUser({ flags: { platformAdmin: 1 } });

    const res = await server.post("/api/pages.info", outsider, {
      body: { id: site.id },
    });
    expect(res.status).toEqual(404);
  });

  it("returns 400 without a valid id", async () => {
    const { admin } = await setup();
    const res = await server.post("/api/pages.info", admin, {
      body: { id: "nope" },
    });
    expect(res.status).toEqual(400);
  });
});

describe("#pages.create", () => {
  it("creates a draft site for the actor's team", async () => {
    const { team, admin } = await setup();
    const slug = uniqueSlug();

    const res = await server.post("/api/pages.create", admin, {
      body: { slug, title: "Launch" },
    });
    const body = await res.json();

    expect(res.status).toEqual(200);
    expect(body.data).toMatchObject({
      slug,
      title: "Launch",
      status: "draft",
      gateType: "code",
      measurementEnabled: false,
      domains: [],
    });

    const stored = await PagesSite.findOne({ where: { slug } });
    expect(stored?.teamId).toEqual(team.id);
    expect(stored?.createdById).toEqual(admin.id);
    expect(stored?.prefix).toEqual(`sites/${slug}/`);
  });

  it("ignores a teamId in the body", async () => {
    const { team, admin } = await setup();
    const other = await buildTeam();
    const slug = uniqueSlug();

    const res = await server.post("/api/pages.create", admin, {
      body: { slug, title: "Launch", teamId: other.id },
    });

    expect(res.status).toEqual(200);
    const stored = await PagesSite.findOne({ where: { slug } });
    expect(stored?.teamId).toEqual(team.id);
  });

  it("creates a pending domain when a hostname is given", async () => {
    const { admin } = await setup();
    const slug = uniqueSlug();
    const host = hostname();

    const res = await server.post("/api/pages.create", admin, {
      body: { slug, title: "Launch", hostname: host, measurementEnabled: true },
    });
    const body = await res.json();

    expect(res.status).toEqual(200);
    expect(body.data.measurementEnabled).toBe(true);
    expect(body.data.domains).toEqual([
      {
        hostname: host,
        verificationStatus: "pending",
        certificateStatus: "pending",
      },
    ]);
  });

  it.each([
    ["reserved", "platform-onboarding"],
    ["uppercase", "My-Site"],
    ["too short", "ab"],
  ])("rejects a %s slug and writes nothing", async (_name, slug) => {
    const { team, admin } = await setup();

    const res = await server.post("/api/pages.create", admin, {
      body: { slug, title: "Launch" },
    });

    expect(res.status).toEqual(400);
    expect(await PagesSite.count({ where: { teamId: team.id } })).toEqual(1);
  });

  it("rejects a slug already in use and creates nothing", async () => {
    const { team, admin } = await setup();
    const taken = await buildPagesSite();

    const res = await server.post("/api/pages.create", admin, {
      body: { slug: taken.slug, title: "Launch" },
    });
    const body = await res.json();

    expect(res.status).toEqual(400);
    expect(body.message).toEqual("This address is already in use");
    expect(await PagesSite.count({ where: { teamId: team.id } })).toEqual(1);
  });

  it.each([
    ["reserved", "app.outline.dev"],
    ["reserved suffix", "docs.tin.info"],
    ["wildcard", "*.client.com"],
  ])(
    "rejects a %s hostname and creates neither site nor domain",
    async (_name, host) => {
      const { admin } = await setup();
      const slug = uniqueSlug();

      const res = await server.post("/api/pages.create", admin, {
        body: { slug, title: "Launch", hostname: host },
      });

      expect(res.status).toEqual(400);
      expect(await PagesSite.count({ where: { slug } })).toEqual(0);
      expect(
        await PagesDomain.count({ where: { hostname: host.toLowerCase() } })
      ).toEqual(0);
    }
  );

  it("rolls back the site when the domain cannot be created", async () => {
    const { admin } = await setup();
    const other = await buildPagesSite();
    const host = hostname();
    await PagesDomain.create({ siteId: other.id, hostname: host });
    const slug = uniqueSlug();

    const res = await server.post("/api/pages.create", admin, {
      body: { slug, title: "Launch", hostname: host },
    });
    const body = await res.json();

    expect(res.status).toEqual(400);
    expect(body.message).toEqual("This domain is already in use");
    expect(await PagesSite.count({ where: { slug } })).toEqual(0);
    expect(await PagesDomain.count({ where: { hostname: host } })).toEqual(1);
  });
});

describe("#pages.update", () => {
  it("updates the title and measurement switch", async () => {
    const { admin, site } = await setup();

    const res = await server.post("/api/pages.update", admin, {
      body: { id: site.id, title: "Renamed", measurementEnabled: true },
    });
    const body = await res.json();

    expect(res.status).toEqual(200);
    expect(body.data.title).toEqual("Renamed");
    expect(body.data.measurementEnabled).toBe(true);
    await site.reload();
    expect(site.title).toEqual("Renamed");
    expect(site.measurementEnabled).toBe(true);
  });

  it("cannot change slug, status, prefix, codeVersion or team", async () => {
    const { admin, site } = await setup();
    const other = await buildTeam();
    const before = site.toJSON();

    const res = await server.post("/api/pages.update", admin, {
      body: {
        id: site.id,
        slug: uniqueSlug(),
        status: "published",
        prefix: "sites/elsewhere/",
        codeVersion: 9,
        teamId: other.id,
      },
    });

    expect([200, 400]).toContain(res.status);
    await site.reload();
    expect(site.slug).toEqual(before.slug);
    expect(site.status).toEqual(before.status);
    expect(site.prefix).toEqual(before.prefix);
    expect(site.codeVersion).toEqual(before.codeVersion);
    expect(site.teamId).toEqual(before.teamId);
  });

  it("returns 404 to another team's admin and changes nothing", async () => {
    const { site } = await setup();
    const outsider = await buildAdmin();

    const res = await server.post("/api/pages.update", outsider, {
      body: { id: site.id, title: "Hijacked" },
    });

    expect(res.status).toEqual(404);
    await site.reload();
    expect(site.title).toEqual("Test site");
  });
});

function hostname() {
  return `docs-${randomString(8).toLowerCase()}.client.com`;
}
