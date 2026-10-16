import { PagesSite } from "@server/models";
import { PagesSiteKind, PagesSiteStatus } from "@server/models/PagesSite";
import { buildAdmin, buildDocument } from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import type { ObjectStore } from "../lib/objectStore";
import { buildPagesSite } from "../test/factories";
import { type MemoryStore, createMemoryStore } from "../test/memoryStore";

// Mount the router with an injected store before the API app is built, as
// publish.test.ts does; the plugin index registers nothing while PAGES_* is unset.
const holder = await vi.hoisted(async () => {
  const { PluginManager, Hook } = await import("@server/utils/PluginManager");
  const { createPagesRouter } = await import("./pages");
  const state: { store?: ObjectStore } = {};
  PluginManager.add({
    type: Hook.API,
    value: createPagesRouter({
      storeFactory: () => {
        if (!state.store) {
          throw new Error("test store not set");
        }
        return state.store;
      },
    }),
  });
  return state;
});

const server = getTestServer();
vi.setConfig({ testTimeout: 60_000 });

let store: MemoryStore;
beforeEach(async () => {
  store = createMemoryStore();
  holder.store = store;
  // Slugs are globally unique and the test database is not reset between
  // tests, so drop rows left by earlier tests or runs using the fixed slugs.
  await PagesSite.destroy({ where: { slug: ["demo-art", "plain-site"] } });
});

async function adminAndArtifactSite() {
  const admin = await buildAdmin();
  const site = await buildPagesSite({
    teamId: admin.teamId,
    createdById: admin.id,
    kind: PagesSiteKind.Artifact,
    slug: "demo-art",
    prefix: "artifacts/demo-art/",
    status: PagesSiteStatus.Published,
    gateType: "none",
  });
  return { admin, site };
}

describe("existing routes on artifact sites", () => {
  it.each(["pages.publish", "pages.rotate"])(
    "%s refuses an artifact site and writes nothing",
    async (route) => {
      const { admin, site } = await adminAndArtifactSite();
      const document = await buildDocument({
        teamId: admin.teamId,
        userId: admin.id,
      });
      const res = await server.post(`/api/${route}`, admin, {
        body: {
          id: site.id,
          sources: [{ type: "document", id: document.id }],
        },
      });
      expect(res.status).toBe(400);
      expect(store.keys()).toEqual([]);
    }
  );

  it("pages.unpublish removes only the artifact's own prefix", async () => {
    const { admin, site } = await adminAndArtifactSite();
    store = createMemoryStore({
      "artifacts/demo-art/index.html": "1",
      "artifacts/demo-art/js/a.js": "2",
      "artifacts/demo-art-two/index.html": "3",
      "sites/demo-art/index.html": "4",
    });
    holder.store = store;
    const res = await server.post("/api/pages.unpublish", admin, {
      body: { id: site.id },
    });
    expect(res.status).toBe(200);
    expect(store.keys()).toEqual([
      "artifacts/demo-art-two/index.html",
      "sites/demo-art/index.html",
    ]);
    expect((await PagesSite.findByPk(site.id))?.status).toBe(
      PagesSiteStatus.Unpublished
    );
  });

  it("pages.delete removes only the artifact's own prefix and the row", async () => {
    const { admin, site } = await adminAndArtifactSite();
    store = createMemoryStore({
      "artifacts/demo-art/index.html": "1",
      "sites/demo-art/index.html": "4",
    });
    holder.store = store;
    const res = await server.post("/api/pages.delete", admin, {
      body: { id: site.id },
    });
    expect(res.status).toBe(200);
    expect(store.keys()).toEqual(["sites/demo-art/index.html"]);
    expect(await PagesSite.findByPk(site.id)).toBeNull();
  });

  it("a pages site still removes sites/<slug>/ only", async () => {
    const admin = await buildAdmin();
    const site = await buildPagesSite({
      teamId: admin.teamId,
      createdById: admin.id,
      slug: "plain-site",
      prefix: "sites/plain-site/",
      status: PagesSiteStatus.Published,
    });
    store = createMemoryStore({
      "sites/plain-site/index.html": "1",
      "artifacts/plain-site/index.html": "2",
    });
    holder.store = store;
    const res = await server.post("/api/pages.delete", admin, {
      body: { id: site.id },
    });
    expect(res.status).toBe(200);
    expect(store.keys()).toEqual(["artifacts/plain-site/index.html"]);
  });
});
