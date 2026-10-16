import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { PagesSite } from "@server/models";
import { PagesSiteKind, PagesSiteStatus } from "@server/models/PagesSite";
import FileStorage from "@server/storage/files";
import {
  buildAdmin,
  buildApiKey,
  buildAttachment,
  buildDocument,
  buildTeam,
  buildUser,
} from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import pagesEnv from "../env";
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
      expect(store.calls).toEqual([]);
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

// --- pages.publishArtifact ---

/** A valid slug unique to this run, as slugs are global and rows persist. */
function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomBytes(5).toString("hex")}`;
}

/** A stored (uncompressed) zip of the given text entries. */
function zip(entries: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const crc32 = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      }
    }
    return ~c >>> 0;
  };
  for (const [name, text] of Object.entries(entries)) {
    const body = Buffer.from(text);
    const nameBuf = Buffer.from(name);
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(body.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

/** An admin, a document they can edit and an attachment holding `bytes`. */
async function setup(name: string, bytes: Buffer) {
  const admin = await buildAdmin();
  const document = await buildDocument({
    teamId: admin.teamId,
    userId: admin.id,
  });
  // The model derives `name` from the key, which the factory builds from its second argument.
  const attachment = await buildAttachment(
    {
      teamId: admin.teamId,
      userId: admin.id,
      documentId: document.id,
      size: bytes.length,
    },
    name
  );
  vi.spyOn(FileStorage, "getFileStream").mockImplementation(async () =>
    Readable.from([bytes])
  );
  return { admin, document, attachment };
}

const publishBody = (
  documentId: string,
  attachmentId: string,
  extra: Record<string, unknown> = {}
) => ({ documentId, attachmentId, ...extra });

describe("pages.publishArtifact", () => {
  const originalBaseUrl = pagesEnv.PAGES_PUBLIC_BASE_URL;
  beforeEach(() => {
    pagesEnv.PAGES_PUBLIC_BASE_URL = "https://pages.example.test";
  });
  afterEach(() => {
    pagesEnv.PAGES_PUBLIC_BASE_URL = originalBaseUrl;
    vi.restoreAllMocks();
  });

  it("publishes a single html file under artifacts/<slug>/", async () => {
    const { admin, document, attachment } = await setup(
      "demo.html",
      Buffer.from("<h1>hi</h1>")
    );
    const slug = uniqueSlug("demo-one");
    const res = await server.post("/api/pages.publishArtifact", admin, {
      body: publishBody(document.id, attachment.id, { slug }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.site.kind).toBe("artifact");
    expect(json.data.site.status).toBe("published");
    expect(json.data.fileCount).toBe(1);
    expect(store.keys()).toEqual([`artifacts/${slug}/index.html`]);
    expect(store.meta(`artifacts/${slug}/index.html`)?.contentType).toBe(
      "text/html; charset=utf-8"
    );
    expect(json.data.publishedUrl).toMatch(
      new RegExp(`/artifacts/${slug}/index\\.html$`)
    );
  });

  it("generates an unguessable slug when none is given", async () => {
    const { admin, document, attachment } = await setup(
      "demo.html",
      Buffer.from("x")
    );
    const res = await server.post("/api/pages.publishArtifact", admin, {
      body: publishBody(document.id, attachment.id),
    });
    const { data } = await res.json();
    expect(data.site.slug).toMatch(/^[0-9a-f]{16}$/);
    expect(store.keys()).toEqual([`artifacts/${data.site.slug}/index.html`]);
  });

  it("publishes a zip with assets and an inline title from the file name", async () => {
    const { admin, document, attachment } = await setup(
      "site.zip",
      zip({ "index.html": "<p>x</p>", "css/app.css": "a{}" })
    );
    const slug = uniqueSlug("zip-site");
    const res = await server.post("/api/pages.publishArtifact", admin, {
      body: publishBody(document.id, attachment.id, { slug }),
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.site.title).toBe("site");
    expect(store.keys()).toEqual([
      `artifacts/${slug}/css/app.css`,
      `artifacts/${slug}/index.html`,
    ]);
  });

  it("republishing replaces stale files and bumps the version", async () => {
    const first = await setup(
      "a.zip",
      zip({ "index.html": "1", "old.js": "2" })
    );
    const slug = uniqueSlug("re-pub");
    const firstRes = await server.post(
      "/api/pages.publishArtifact",
      first.admin,
      {
        body: publishBody(first.document.id, first.attachment.id, { slug }),
      }
    );
    expect(firstRes.status).toBe(200);
    vi.restoreAllMocks();
    const attachment = await buildAttachment(
      {
        teamId: first.admin.teamId,
        userId: first.admin.id,
        documentId: first.document.id,
        size: 10,
      },
      "b.zip"
    );
    vi.spyOn(FileStorage, "getFileStream").mockImplementation(async () =>
      Readable.from([zip({ "index.html": "new" })])
    );
    const res = await server.post("/api/pages.publishArtifact", first.admin, {
      body: publishBody(first.document.id, attachment.id, { slug }),
    });
    expect(res.status).toBe(200);
    expect(store.keys()).toEqual([`artifacts/${slug}/index.html`]);
    expect(store.text(`artifacts/${slug}/index.html`)).toBe("new");
    expect((await PagesSite.findOne({ where: { slug } }))?.currentVersion).toBe(
      2
    );
  });

  it("accepts an API key of an admin", async () => {
    const { admin, document, attachment } = await setup(
      "demo.html",
      Buffer.from("x")
    );
    const apiKey = await buildApiKey({ userId: admin.id });
    const slug = uniqueSlug("via-key");
    const res = await server.post("/api/pages.publishArtifact", {
      body: publishBody(document.id, attachment.id, { slug }),
      headers: { Authorization: `Bearer ${apiKey.value}` },
    });
    expect(res.status).toBe(200);
    expect(store.keys()).toEqual([`artifacts/${slug}/index.html`]);
  });

  it("refuses an API key whose scope excludes the route, writing nothing", async () => {
    const { admin, document, attachment } = await setup(
      "demo.html",
      Buffer.from("x")
    );
    const apiKey = await buildApiKey({
      userId: admin.id,
      scope: ["documents:read"],
    });
    const slug = uniqueSlug("scoped");
    const res = await server.post("/api/pages.publishArtifact", {
      body: publishBody(document.id, attachment.id, { slug }),
      headers: { Authorization: `Bearer ${apiKey.value}` },
    });
    expect(res.status).toBe(403);
    expect(store.keys()).toEqual([]);
    expect(await PagesSite.findOne({ where: { slug } })).toBeNull();
  });

  it("refuses a non-admin user, writing nothing", async () => {
    const admin = await buildAdmin();
    const member = await buildUser({ teamId: admin.teamId });
    const document = await buildDocument({
      teamId: admin.teamId,
      userId: member.id,
    });
    const attachment = await buildAttachment(
      {
        teamId: admin.teamId,
        userId: member.id,
        documentId: document.id,
        size: 1,
      },
      "demo.html"
    );
    vi.spyOn(FileStorage, "getFileStream").mockImplementation(async () =>
      Readable.from([Buffer.from("x")])
    );
    const apiKey = await buildApiKey({ userId: member.id });
    const slug = uniqueSlug("nope");
    const res = await server.post("/api/pages.publishArtifact", {
      body: publishBody(document.id, attachment.id, { slug }),
      headers: { Authorization: `Bearer ${apiKey.value}` },
    });
    expect(res.status).toBe(403);
    expect(store.keys()).toEqual([]);
    expect(await PagesSite.findOne({ where: { slug } })).toBeNull();
  });

  it("404s for another team's document and writes nothing", async () => {
    const { admin, attachment } = await setup("demo.html", Buffer.from("x"));
    const otherTeam = await buildTeam();
    const foreign = await buildDocument({ teamId: otherTeam.id });
    const slug = uniqueSlug("cross-team");
    const res = await server.post("/api/pages.publishArtifact", admin, {
      body: publishBody(foreign.id, attachment.id, { slug }),
    });
    expect(res.status).toBe(404);
    expect(store.keys()).toEqual([]);
    expect(await PagesSite.count({ where: { slug } })).toBe(0);
  });

  it("404s for an attachment that belongs to another document", async () => {
    const { admin, document } = await setup("demo.html", Buffer.from("x"));
    const otherDoc = await buildDocument({
      teamId: admin.teamId,
      userId: admin.id,
    });
    const other = await buildAttachment(
      {
        teamId: admin.teamId,
        userId: admin.id,
        documentId: otherDoc.id,
        size: 1,
      },
      "x.html"
    );
    const slug = uniqueSlug("wrong-doc");
    const res = await server.post("/api/pages.publishArtifact", admin, {
      body: publishBody(document.id, other.id, { slug }),
    });
    expect(res.status).toBe(404);
    expect(store.keys()).toEqual([]);
    expect(await PagesSite.count({ where: { slug } })).toBe(0);
  });

  it("refuses a slug used by a pages site or another team, with the same message", async () => {
    const { admin, document, attachment } = await setup(
      "demo.html",
      Buffer.from("x")
    );
    const pagesSlug = uniqueSlug("taken-pages");
    await buildPagesSite({ teamId: admin.teamId, slug: pagesSlug });
    const other = await buildPagesSite({
      kind: PagesSiteKind.Artifact,
      slug: uniqueSlug("taken-other"),
    });
    const a = await server.post("/api/pages.publishArtifact", admin, {
      body: publishBody(document.id, attachment.id, { slug: pagesSlug }),
    });
    const b = await server.post("/api/pages.publishArtifact", admin, {
      body: publishBody(document.id, attachment.id, { slug: other.slug }),
    });
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    expect((await a.json()).message).toBe((await b.json()).message);
    expect(store.keys()).toEqual([]);
  });

  it.each(["AB", "bad slug", "../x", "robots.txt", "-no", "no-"])(
    "rejects slug %j",
    async (slug) => {
      const { admin, document, attachment } = await setup(
        "demo.html",
        Buffer.from("x")
      );
      const res = await server.post("/api/pages.publishArtifact", admin, {
        body: publishBody(document.id, attachment.id, { slug }),
      });
      expect(res.status).toBe(400);
      expect(store.keys()).toEqual([]);
    }
  );

  it("surfaces a bundle error as 400 and writes nothing", async () => {
    const { admin, document, attachment } = await setup(
      "evil.zip",
      zip({ "index.html": "x", "../evil.html": "y" })
    );
    const slug = uniqueSlug("evil-zip");
    const res = await server.post("/api/pages.publishArtifact", admin, {
      body: publishBody(document.id, attachment.id, { slug }),
    });
    expect(res.status).toBe(400);
    expect(store.keys()).toEqual([]);
    expect(await PagesSite.count({ where: { slug } })).toBe(0);
  });

  it("stops reading an oversized attachment early and writes nothing", async () => {
    const { admin, document, attachment } = await setup(
      "big.html",
      Buffer.from("x")
    );
    const chunk = Buffer.alloc(1024 * 1024, 1);
    let pulled = 0;
    const source = new Readable({
      read() {
        pulled += 1;
        this.push(pulled > 60 ? null : chunk);
      },
    });
    vi.spyOn(FileStorage, "getFileStream").mockImplementation(
      async () => source
    );
    const slug = uniqueSlug("too-big");
    const res = await server.post("/api/pages.publishArtifact", admin, {
      body: publishBody(document.id, attachment.id, { slug }),
    });
    expect(res.status).toBe(400);
    expect(source.destroyed).toBe(true);
    expect(pulled).toBeLessThan(60);
    expect(store.keys()).toEqual([]);
    expect(await PagesSite.count({ where: { slug } })).toBe(0);
  });

  it("leaves a draft site when the upload fails, never a published one", async () => {
    const { admin, document, attachment } = await setup(
      "demo.html",
      Buffer.from("x")
    );
    const slug = uniqueSlug("half-way");
    store.failOn("put", `artifacts/${slug}/index.html`);
    const res = await server.post("/api/pages.publishArtifact", admin, {
      body: publishBody(document.id, attachment.id, { slug }),
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await PagesSite.findOne({ where: { slug } }))?.status).toBe(
      PagesSiteStatus.Draft
    );
  });

  it("never injects a gate or beacon into artifact html", async () => {
    const html = "<!doctype html><title>t</title><p>plain</p>";
    const { admin, document, attachment } = await setup(
      "plain.html",
      Buffer.from(html)
    );
    const slug = uniqueSlug("plain-art");
    const res = await server.post("/api/pages.publishArtifact", admin, {
      body: publishBody(document.id, attachment.id, { slug }),
    });
    expect(res.status).toBe(200);
    expect(store.text(`artifacts/${slug}/index.html`)).toBe(html);
  });
});
