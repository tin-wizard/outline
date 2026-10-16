import crypto from "node:crypto";
import { Socket } from "node:net";
import { inspect } from "node:util";
import { randomString } from "@shared/random";
import env from "@server/env";
import Logger from "@server/logging/Logger";
import {
  type Document,
  PagesDomain,
  PagesPublication,
  PagesSite,
} from "@server/models";
import { PagesSourceType } from "@server/models/PagesPublication";
import { PagesSiteStatus } from "@server/models/PagesSite";
import {
  buildAdmin,
  buildApiKey,
  buildCollection,
  buildDocument,
  buildGuestUser,
  buildTeam,
  buildUser,
  buildViewer,
} from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import RateLimiter, { RateLimiterStrategy } from "@server/utils/RateLimiter";
import pagesEnv from "../env";
import { normalizeCode, parseGatePage, verifyCode } from "../lib/gate";
import type { ObjectStore } from "../lib/objectStore";
import { buildPagesSite } from "../test/factories";
import { type MemoryStore, createMemoryStore } from "../test/memoryStore";
import { PUBLISH_TIMEOUT_MS } from "./publish";

// Real PBKDF2 at 600000 iterations is proven in gate.test.ts and
// api/publishE2E.test.ts; here it runs the same algorithm with fewer
// iterations so the shared threadpool is not saturated.
vi.mock("node:crypto", async (importOriginal) => {
  const { mockCryptoPbkdf2, TEST_PBKDF2_ITERATIONS } =
    await import("../test/fastPbkdf2");
  return mockCryptoPbkdf2(await importOriginal(), TEST_PBKDF2_ITERATIONS);
});

afterAll(async () => {
  const { pbkdf2Calls, TEST_PBKDF2_ITERATIONS } =
    await import("../test/fastPbkdf2");
  expect(pbkdf2Calls.length).toBeGreaterThan(0);
  expect(pbkdf2Calls.filter((n) => n !== TEST_PBKDF2_ITERATIONS)).toEqual([]);
});

// The first request boots the app; under a parallel run it can pass 5s.
vi.setConfig({ testTimeout: 60_000 });

// Mount the router with an injected store before the API app is built, as
// pages.test.ts does; the plugin index registers nothing while PAGES_* is unset.
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
const BASE_URL = "https://pages.example.test";
const MARKER = "PLAINTEXT-MARKER-x4Kp";
const CODE_PATTERN = /^[a-hj-km-np-z2-9]{4}(-[a-hj-km-np-z2-9]{4}){3}$/;

let store: MemoryStore;
const originalBaseUrl = pagesEnv.PAGES_PUBLIC_BASE_URL;

beforeEach(() => {
  store = createMemoryStore();
  holder.store = store;
  pagesEnv.PAGES_PUBLIC_BASE_URL = BASE_URL;
});

afterEach(() => {
  pagesEnv.PAGES_PUBLIC_BASE_URL = originalBaseUrl;
  vi.restoreAllMocks();
});

async function setupSite(slug?: string) {
  const team = await buildTeam();
  const admin = await buildAdmin({ teamId: team.id });
  const site = await buildPagesSite({
    teamId: team.id,
    createdById: admin.id,
    ...(slug ? { slug } : {}),
  });
  const document = await buildDocument({
    teamId: team.id,
    userId: admin.id,
    title: "Handbook",
    text: `Hello ${MARKER}`,
  });
  return { team, admin, site, document };
}

const setup = setupSite;

const docSource = (document: Document) => [
  { type: "document", id: document.id },
];

const puts = () => store.calls.filter((c) => c.startsWith("put "));
const siteKeys = (site: PagesSite) =>
  store.keys().filter((k) => k.startsWith(`sites/${site.slug}/`));

function post(
  route: string,
  user: Parameters<typeof server.post>[1],
  body: object
) {
  return server.post(`/api/${route}`, user, { body });
}

async function publishFirst(
  admin: Parameters<typeof server.post>[1],
  site: PagesSite,
  document: Document
): Promise<string> {
  const res = await post("pages.publish", admin, {
    id: site.id,
    sources: docSource(document),
  });
  expect(res.status).toEqual(200);
  const body = await res.json();
  return body.data.accessCode;
}

describe("#pages.publish", () => {
  it("issues an access code on first publish", async () => {
    const { admin, site, document } = await setup();

    const res = await post("pages.publish", admin, {
      id: site.id,
      sources: docSource(document),
    });
    const body = await res.json();

    expect(res.status).toEqual(200);
    expect(res.headers.get("cache-control")).toEqual("no-store");
    expect(body.data.accessCode).toMatch(CODE_PATTERN);
    const url = `${BASE_URL}/sites/${site.slug}/index.html`;
    expect(body.data.publishedUrl).toEqual(url);
    expect(body.data.pageCount).toEqual(1);
    expect(body.data.warnings).toEqual([]);
    expect(body.data.site.status).toEqual(PagesSiteStatus.Published);
    expect(body.data.site.publishedUrl).toEqual(url);
    expect(body.data.site.pages).toEqual([
      {
        pageKey: "index.html",
        title: "Handbook",
        publishedAt: expect.any(String),
      },
    ]);
    expect(JSON.stringify(body.data.site)).not.toContain(body.data.accessCode);

    const index = store.text(`sites/${site.slug}/index.html`) ?? "";
    expect(await verifyCode(body.data.accessCode, index)).toBe(true);
    for (const key of store.keys()) {
      expect(store.text(key)).not.toContain(MARKER);
    }
  });

  it("requires and checks the current code on republish", async () => {
    const { admin, site, document } = await setup();
    const code = await publishFirst(admin, site, document);
    const indexKey = `sites/${site.slug}/index.html`;
    const salt = parseGatePage(store.text(indexKey) ?? "")?.salt;

    const missing = await post("pages.publish", admin, { id: site.id });
    expect(missing.status).toEqual(400);
    expect((await missing.json()).error).toEqual("access_code_required");

    const wrong = await post("pages.publish", admin, {
      id: site.id,
      accessCode: "aaaa-bbbb-cccc-dddd",
    });
    expect(wrong.status).toEqual(400);
    expect((await wrong.json()).error).toEqual("incorrect_code");

    // Sources omitted: the stored sources are reused.
    const right = await post("pages.publish", admin, {
      id: site.id,
      accessCode: code,
    });
    const body = await right.json();
    expect(right.status).toEqual(200);
    expect(body.data).not.toHaveProperty("accessCode");
    expect(body.data.site.currentVersion).toEqual(2);
    expect(parseGatePage(store.text(indexKey) ?? "")?.salt).toEqual(salt);
  });

  it("refuses a first publish without sources", async () => {
    const { admin, site } = await setup();
    const res = await post("pages.publish", admin, { id: site.id });
    expect(res.status).toEqual(400);
    expect(puts()).toEqual([]);
  });

  it("returns 404 and uploads nothing for another team's document", async () => {
    const { admin, site } = await setup();
    const foreign = await buildDocument();
    const res = await post("pages.publish", admin, {
      id: site.id,
      sources: docSource(foreign),
    });
    expect(res.status).toEqual(404);
    expect(puts()).toEqual([]);
  });

  it("returns 404 and uploads nothing for another team's collection", async () => {
    const { admin, site, document } = await setup();
    const foreign = await buildCollection();
    const res = await post("pages.publish", admin, {
      id: site.id,
      sources: [
        { type: "document", id: document.id },
        { type: "collection", id: foreign.id },
      ],
    });
    expect(res.status).toEqual(404);
    expect(puts()).toEqual([]);
  });

  it("refuses a document the actor cannot read and uploads nothing", async () => {
    const { team, admin, site } = await setup();
    const owner = await buildUser({ teamId: team.id });
    const secret = await buildCollection({
      teamId: team.id,
      userId: owner.id,
      permission: null,
    });
    const hidden = await buildDocument({
      teamId: team.id,
      userId: owner.id,
      collectionId: secret.id,
    });
    const res = await post("pages.publish", admin, {
      id: site.id,
      sources: docSource(hidden),
    });
    expect(res.status).toEqual(403);
    expect(puts()).toEqual([]);
  });

  it("skips unreadable documents of a collection with a warning", async () => {
    const { team, admin, site, document } = await setup();
    const owner = await buildUser({ teamId: team.id });
    const secret = await buildCollection({
      teamId: team.id,
      userId: owner.id,
      permission: null,
    });
    const hidden = await buildDocument({
      teamId: team.id,
      userId: owner.id,
      collectionId: secret.id,
      title: "Secret plans",
    });

    const res = await post("pages.publish", admin, {
      id: site.id,
      sources: [
        { type: "document", id: document.id },
        { type: "collection", id: secret.id },
      ],
    });
    const body = await res.json();

    expect(res.status).toEqual(200);
    expect(body.data.pageCount).toEqual(2);
    expect(body.data.warnings.join(" ")).toMatch(/permission/);
    expect(JSON.stringify(body)).not.toContain(hidden.title);
    expect(
      await PagesPublication.count({ where: { sourceId: hidden.id } })
    ).toEqual(0);
  });

  it("refuses more than 20 sources", async () => {
    const { admin, site, document } = await setup();
    const sources = Array.from({ length: 21 }, () => ({
      type: "document",
      id: document.id,
    }));
    const res = await post("pages.publish", admin, { id: site.id, sources });
    expect(res.status).toEqual(400);
  });

  it.each([
    [
      "site id",
      (id: string) => ({ id: "nope", sources: [{ type: "document", id }] }),
    ],
    ["source id", () => ({ sources: [{ type: "document", id: "nope" }] })],
  ])("refuses a bad %s", async (_name, make) => {
    const { admin, site, document } = await setup();
    const res = await post("pages.publish", admin, {
      id: site.id,
      ...make(document.id),
    });
    expect(res.status).toEqual(400);
  });

  it.each([
    ["an over-long", `${MARKER}${"z".repeat(500)}`, MARKER],
    ["a non-string", 987654321987, "987654321987"],
  ])("does not echo %s access code", async (_name, accessCode, needle) => {
    const { admin, site, document } = await setup();
    const res = await post("pages.publish", admin, {
      id: site.id,
      sources: docSource(document),
      accessCode,
    });
    expect(res.status).toEqual(400);
    expect(await res.text()).not.toContain(needle);
  });

  it("ignores and does not persist extra body keys", async () => {
    const { admin, site, document } = await setup();
    const res = await post("pages.publish", admin, {
      id: site.id,
      sources: docSource(document),
      slug: "hijacked-slug",
      status: "draft",
      codeVersion: 42,
      teamId: (await buildTeam()).id,
    });
    expect(res.status).toEqual(200);
    const reloaded = await PagesSite.findByPk(site.id, { rejectOnEmpty: true });
    expect(reloaded.slug).toEqual(site.slug);
    expect(reloaded.teamId).toEqual(site.teamId);
    expect(reloaded.codeVersion).toEqual(1);
    expect(reloaded.status).toEqual(PagesSiteStatus.Published);
  });
});

describe.each([
  "pages.publish",
  "pages.rotate",
  "pages.unpublish",
  "pages.delete",
])("%s access", (route) => {
  const bodyFor = (site: PagesSite, document: Document) =>
    route === "pages.publish" || route === "pages.rotate"
      ? { id: site.id, sources: docSource(document) }
      : { id: site.id };

  // Rotation needs a live site; seed one and forget its upload.
  const setup = async () => {
    const result = await setupSite();
    if (route === "pages.rotate") {
      await seedPublished(result.site);
      store.calls.length = 0;
    }
    return result;
  };

  it("refuses an unauthenticated request with 401", async () => {
    const { site, document } = await setup();
    const res = await server.post(`/api/${route}`, {
      body: bodyFor(site, document),
    });
    expect(res.status).toEqual(401);
    expect(puts()).toEqual([]);
  });

  it.each([
    ["member", buildUser],
    ["viewer", buildViewer],
    ["guest", buildGuestUser],
  ])("refuses a %s with 403", async (_role, build) => {
    const { team, site, document } = await setup();
    const user = await build({ teamId: team.id });
    const res = await post(route, user, bodyFor(site, document));
    expect(res.status).toEqual(403);
    expect(puts()).toEqual([]);
    expect(await PagesSite.findByPk(site.id)).not.toBeNull();
  });

  it("allows an admin", async () => {
    const { admin, site, document } = await setup();
    const res = await post(route, admin, bodyFor(site, document));
    expect(res.status).toEqual(200);
  });

  it("allows a platform admin without the admin role", async () => {
    const { team, site, document } = await setup();
    const platformAdmin = await buildUser({
      teamId: team.id,
      flags: { platformAdmin: 1 },
    });
    const res = await post(route, platformAdmin, bodyFor(site, document));
    expect(res.status).toEqual(200);
  });

  it("returns 404 to another team's admin", async () => {
    const { site, document } = await setup();
    const outsider = await buildAdmin();
    const res = await post(route, outsider, bodyFor(site, document));
    expect(res.status).toEqual(404);
    expect(puts()).toEqual([]);
    expect(await PagesSite.findByPk(site.id)).not.toBeNull();
  });

  it("refuses an admin's API key", async () => {
    const { admin, site, document } = await setup();
    const apiKey = await buildApiKey({ userId: admin.id });
    const res = await server.post(`/api/${route}`, {
      body: bodyFor(site, document),
      headers: { Authorization: `Bearer ${apiKey.value}` },
    });
    expect(res.status).toEqual(403);
    expect(puts()).toEqual([]);
  });
});

describe("socket timeout", () => {
  it.each(["pages.publish", "pages.rotate", "pages.unpublish", "pages.delete"])(
    "extends %s to 120 s",
    async (name) => {
      const { admin } = await setup();
      const setTimeout = vi.spyOn(Socket.prototype, "setTimeout");

      // An unknown site: the timeout applies before the handler runs.
      const res = await post(name, admin, { id: crypto.randomUUID() });

      expect(res.status).toEqual(404);
      expect(PUBLISH_TIMEOUT_MS).toEqual(120_000);
      expect(setTimeout.mock.calls.map(([ms]) => ms)).toContain(
        PUBLISH_TIMEOUT_MS
      );
    }
  );
});

describe("reload after publish", () => {
  it("still returns the issued code when the reload fails", async () => {
    const { admin, site, document } = await setup();
    const findByPk = PagesSite.findByPk.bind(PagesSite);
    // Only the presenter reload passes an include; the publish's own reads do not.
    vi.spyOn(PagesSite, "findByPk").mockImplementation((id, options) =>
      options?.include
        ? Promise.reject(new Error("reload failed"))
        : findByPk(id, options)
    );
    vi.spyOn(Logger, "warn").mockImplementation(() => undefined);

    const res = await post("pages.publish", admin, {
      id: site.id,
      sources: docSource(document),
    });
    const body = await res.json();

    expect(res.status).toEqual(200);
    expect(body.data.accessCode).toMatch(CODE_PATTERN);
    const index = store.text(`sites/${site.slug}/index.html`) ?? "";
    expect(await verifyCode(body.data.accessCode, index)).toBe(true);
    expect(body.data.site.status).toEqual(PagesSiteStatus.Published);
    expect(body.data.publishedUrl).toEqual(
      `${BASE_URL}/sites/${site.slug}/index.html`
    );
    expect(JSON.stringify(body.data.site)).not.toContain(body.data.accessCode);
  });
});

describe("#pages.unpublish", () => {
  it("removes the objects and resets the code", async () => {
    const { admin, site, document } = await setup();
    const first = await publishFirst(admin, site, document);

    const res = await post("pages.unpublish", admin, { id: site.id });
    const body = await res.json();

    expect(res.status).toEqual(200);
    expect(body.data.status).toEqual(PagesSiteStatus.Unpublished);
    expect(body.data.publishedUrl).toBeNull();
    expect(body.data.pages).toEqual([]);
    expect(siteKeys(site)).toEqual([]);
    const reloaded = await PagesSite.findByPk(site.id, { rejectOnEmpty: true });
    expect(reloaded.status).toEqual(PagesSiteStatus.Unpublished);
    expect(reloaded.codeVersion).toEqual(0);
    expect(reloaded.currentVersion).toEqual(1);
    expect(
      await PagesPublication.count({ where: { siteId: site.id } })
    ).toEqual(0);

    const again = await post("pages.publish", admin, {
      id: site.id,
      sources: docSource(document),
    });
    const next = (await again.json()).data.accessCode;
    expect(again.status).toEqual(200);
    expect(next).toMatch(CODE_PATTERN);
    expect(next).not.toEqual(first);
  });

  it("leaves a sibling site with a prefix-sharing slug untouched", async () => {
    const slug = `foo-${randomString(8).toLowerCase()}`;
    const { admin, site } = await setup(slug);
    await store.put(`sites/${slug}/index.html`, "mine", {
      contentType: "text/html",
    });
    const sibling = `sites/${slug}-bar/index.html`;
    await store.put(sibling, "theirs", { contentType: "text/html" });

    const res = await post("pages.unpublish", admin, { id: site.id });

    expect(res.status).toEqual(200);
    expect(store.keys()).toEqual([sibling]);
  });

  it("changes nothing when a key survives removal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { admin, site } = await setup();
    await seedPublished(site);
    const indexKey = `sites/${site.slug}/index.html`;
    // The first listing undercounts, as a paginated listing can.
    let listed = 0;
    holder.store = {
      ...store,
      list: async (prefix) => {
        const keys = await store.list(prefix);
        return listed++ === 0 ? keys.filter((k) => k !== indexKey) : keys;
      },
    };

    const res = await post("pages.unpublish", admin, { id: site.id });

    expect(res.status).toEqual(500);
    await expectStillPublished(site);
  });

  it("changes nothing when removal fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { admin, site } = await setup();
    await seedPublished(site);
    store.failOn("delete", `sites/${site.slug}/index.html`);

    const res = await post("pages.unpublish", admin, { id: site.id });

    expect(res.status).toEqual(500);
    await expectStillPublished(site);
  });
});

describe("#pages.delete", () => {
  it("removes the site, its children and its objects", async () => {
    const { admin, site } = await setup();
    await seedPublished(site);
    await PagesDomain.create({
      siteId: site.id,
      hostname: `${randomString(8).toLowerCase()}.example.com`,
    });

    const res = await post("pages.delete", admin, { id: site.id });

    expect(res.status).toEqual(200);
    expect(await PagesSite.findByPk(site.id)).toBeNull();
    expect(
      await PagesPublication.count({ where: { siteId: site.id } })
    ).toEqual(0);
    expect(await PagesDomain.count({ where: { siteId: site.id } })).toEqual(0);
    expect(siteKeys(site)).toEqual([]);
  });

  it("keeps the row when removal fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { admin, site } = await setup();
    await seedPublished(site);
    store.failOn("delete", `sites/${site.slug}/index.html`);

    const res = await post("pages.delete", admin, { id: site.id });

    expect(res.status).toEqual(500);
    await expectStillPublished(site);
  });
});

describe("#pages.rotate", () => {
  const indexText = (site: PagesSite) =>
    store.text(`sites/${site.slug}/index.html`) ?? "";

  it("issues a new code that opens the live site while the old one does not", async () => {
    const { admin, site, document } = await setup();
    const oldCode = await publishFirst(admin, site, document);

    // Sources omitted: the stored sources are reused. A code is not accepted.
    const res = await post("pages.rotate", admin, {
      id: site.id,
      accessCode: oldCode,
    });
    const body = await res.json();

    expect(res.status).toEqual(200);
    expect(res.headers.get("cache-control")).toEqual("no-store");
    expect(body.data.accessCode).toMatch(CODE_PATTERN);
    expect(body.data.accessCode).not.toEqual(oldCode);
    expect(body.data.pageCount).toEqual(1);
    expect(body.data.warnings).toEqual([]);
    expect(body.data.publishedUrl).toEqual(
      `${BASE_URL}/sites/${site.slug}/index.html`
    );
    expect(body.data.site.currentVersion).toEqual(2);
    expect(body.data.site.rotatedAt).toEqual(expect.any(String));
    expect(JSON.stringify(body.data.site)).not.toContain(body.data.accessCode);
    expect(await verifyCode(body.data.accessCode, indexText(site))).toBe(true);
    expect(await verifyCode(oldCode, indexText(site))).toBe(false);

    const reloaded = await PagesSite.findByPk(site.id, { rejectOnEmpty: true });
    expect(reloaded.codeVersion).toEqual(2);
    expect(reloaded.rotatedById).toEqual(admin.id);
  });

  it("returns 409 and uploads nothing for a never-published site", async () => {
    const { admin, site, document } = await setup();
    const res = await post("pages.rotate", admin, {
      id: site.id,
      sources: docSource(document),
    });
    expect(res.status).toEqual(409);
    expect((await res.json()).error).toEqual("nothing_to_rotate");
    expect(puts()).toEqual([]);
  });

  it("returns 404 and changes nothing for another team's document", async () => {
    const { admin, site, document } = await setup();
    const oldCode = await publishFirst(admin, site, document);
    const mark = store.calls.length;
    const foreign = await buildDocument();

    const res = await post("pages.rotate", admin, {
      id: site.id,
      sources: docSource(foreign),
    });

    expect(res.status).toEqual(404);
    expect(store.calls.slice(mark).filter((c) => c.startsWith("put "))).toEqual(
      []
    );
    const reloaded = await PagesSite.findByPk(site.id, { rejectOnEmpty: true });
    expect(reloaded.codeVersion).toEqual(1);
    expect(reloaded.rotatedAt).toBeNull();
    expect(await verifyCode(oldCode, indexText(site))).toBe(true);
  });

  it("is rate limited with the strict strategy", async () => {
    const enabled = env.RATE_LIMITER_ENABLED;
    const multiplier = env.RATE_LIMITER_MULTIPLIER;
    env.RATE_LIMITER_ENABLED = true;
    env.RATE_LIMITER_MULTIPLIER = 1;
    try {
      const { admin, site } = await setup();
      await post("pages.rotate", admin, { id: site.id });
      const path = RateLimiter.normalizePath("/api/pages.rotate");
      expect(RateLimiter.hasRateLimiter(path)).toBe(true);
      expect(RateLimiter.getRateLimiter(path).points).toEqual(
        RateLimiterStrategy.FivePerMinute.requests
      );
    } finally {
      env.RATE_LIMITER_ENABLED = enabled;
      env.RATE_LIMITER_MULTIPLIER = multiplier;
    }
  });

  it("serialises concurrent rotations so exactly one issued code opens the site", async () => {
    const { admin, site, document } = await setup();
    const oldCode = await publishFirst(admin, site, document);

    const responses = await Promise.all([
      post("pages.rotate", admin, { id: site.id }),
      post("pages.rotate", admin, { id: site.id }),
    ]);
    const succeeded: string[] = [];
    for (const res of responses) {
      const body = await res.json();
      if (res.status === 200) {
        expect(body.data.accessCode).toMatch(CODE_PATTERN);
        succeeded.push(body.data.accessCode);
      } else {
        expect(res.status).toBeLessThan(500);
      }
    }

    expect(succeeded.length).toBeGreaterThan(0);
    const opening = [];
    for (const code of [oldCode, ...succeeded]) {
      if (await verifyCode(code, indexText(site))) {
        opening.push(code);
      }
    }
    expect(opening).toHaveLength(1);
    expect(succeeded).toContain(opening[0]);
    for (const key of siteKeys(site)) {
      expect(await verifyCode(opening[0], store.text(key) ?? "")).toBe(true);
    }
    const reloaded = await PagesSite.findByPk(site.id, { rejectOnEmpty: true });
    expect(reloaded.codeVersion).toEqual(succeeded.length + 1);
  });
});

describe("access code secrecy", () => {
  it("never logs the issued or the supplied code", async () => {
    const spies = [
      ...(["info", "debug", "silly", "warn", "error", "fatal"] as const).map(
        (method) => vi.spyOn(Logger, method)
      ),
      ...(["log", "info", "warn", "error", "debug"] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined)
      ),
    ];
    const { admin, site, document } = await setup();
    const wrongCode = "wxyz-wxyz-wxyz-wxyz";

    const issued = await publishFirst(admin, site, document);
    const wrong = await post("pages.publish", admin, {
      id: site.id,
      accessCode: wrongCode,
    });
    expect(wrong.status).toEqual(400);
    expect(await wrong.text()).not.toContain(wrongCode);

    store.failOn("put", `sites/${site.slug}/index.html`);
    const failing = await post("pages.publish", admin, {
      id: site.id,
      accessCode: issued,
    });
    expect(failing.status).toEqual(500);
    expect(await failing.text()).not.toContain(issued);

    const logged = spies
      .flatMap((spy) => spy.mock.calls.flat())
      .map((arg) => inspect(arg, { depth: 10 }))
      .join("\n");
    expect(logged).not.toContain(issued);
    expect(logged).not.toContain(wrongCode);
  });

  it("never logs the rotated, previous or submitted code", async () => {
    const spies = [
      ...(["info", "debug", "silly", "warn", "error", "fatal"] as const).map(
        (method) => vi.spyOn(Logger, method)
      ),
      ...(["log", "info", "warn", "error", "debug"] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined)
      ),
    ];
    const { admin, site, document } = await setup();
    const submitted = "qrst-qrst-qrst-qrst";
    const previous = await publishFirst(admin, site, document);

    const res = await post("pages.rotate", admin, {
      id: site.id,
      accessCode: submitted,
    });
    const text = await res.text();
    expect(res.status).toEqual(200);
    const rotated = JSON.parse(text).data.accessCode;
    expect(text).not.toContain(submitted);
    expect(text).not.toContain(previous);
    expect(text.split(rotated)).toHaveLength(2);

    store.failOn("put", `sites/${site.slug}/index.html`);
    const failing = await post("pages.rotate", admin, { id: site.id });
    expect(failing.status).toEqual(500);
    const failingText = await failing.text();
    expect(failingText).not.toContain(rotated);

    const logged = spies
      .flatMap((spy) => spy.mock.calls.flat())
      .map((arg) => inspect(arg, { depth: 10 }))
      .join("\n");
    for (const code of [previous, rotated, submitted]) {
      expect(logged).not.toContain(code);
      expect(logged).not.toContain(code.replace(/-/g, ""));
    }
  });
});

/** Puts a site in the published state without the cost of a real publish. */
async function seedPublished(site: PagesSite) {
  const objectKey = `sites/${site.slug}/index.html`;
  await store.put(objectKey, "gate page", { contentType: "text/html" });
  await site.update({
    status: PagesSiteStatus.Published,
    currentVersion: 1,
    codeVersion: 1,
  });
  await PagesPublication.create({
    siteId: site.id,
    pageKey: "index.html",
    sourceType: PagesSourceType.Document,
    sourceId: site.id,
    contentHash: "0".repeat(64),
    objectKey,
    publishedAt: new Date(),
  });
}

async function expectStillPublished(site: PagesSite) {
  const reloaded = await PagesSite.findByPk(site.id, { rejectOnEmpty: true });
  expect(reloaded.status).toEqual(PagesSiteStatus.Published);
  expect(reloaded.codeVersion).toEqual(1);
  expect(await PagesPublication.count({ where: { siteId: site.id } })).toEqual(
    1
  );
}

describe("measurement beacon", () => {
  const OPEN_TAG = "<script data-pages-beacon>";
  // Read when used: the test server sets env.URL as it boots.
  const endpoint = () => `${env.URL}/api/pages.ingest`;

  /** Decrypts a gate page as the browser would (PBKDF2 is mocked here). */
  function unlock(code: string, gateHtml: string): string {
    const parsed = parseGatePage(gateHtml);
    if (!parsed) {
      throw new Error("not a gate page");
    }
    const key = crypto.pbkdf2Sync(
      normalizeCode(code),
      parsed.salt,
      600000,
      32,
      "sha256"
    );
    const { blob } = parsed;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      blob.subarray(0, 12)
    );
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    return Buffer.concat([
      decipher.update(blob.subarray(12, blob.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  }

  const sha256 = (text: string) =>
    crypto.createHash("sha256").update(text, "utf8").digest("hex");

  async function setupCollectionSite(measurementEnabled: boolean) {
    const team = await buildTeam();
    const admin = await buildAdmin({ teamId: team.id });
    const site = await buildPagesSite({
      teamId: team.id,
      createdById: admin.id,
      measurementEnabled,
    });
    const collection = await buildCollection({
      teamId: team.id,
      userId: admin.id,
    });
    for (const title of ["Alpha", "Beta"]) {
      await buildDocument({
        teamId: team.id,
        userId: admin.id,
        collectionId: collection.id,
        title,
        text: `Hello ${MARKER}`,
      });
    }
    return { admin, site, collection };
  }

  /** Every published page: its key, outer gate page and decrypted plaintext. */
  async function publishedPages(site: PagesSite, code: string) {
    const rows = await PagesPublication.findAll({ where: { siteId: site.id } });
    return siteKeys(site).map((key) => {
      const pageKey = key.slice(`sites/${site.slug}/`.length);
      const gatePage = store.text(key) ?? "";
      const row = rows.find((r) => r.pageKey === pageKey);
      return {
        pageKey,
        gatePage,
        plaintext: unlock(code, gatePage),
        contentHash: row?.contentHash,
      };
    });
  }

  it("adds no beacon when measurement is off", async () => {
    const { admin, site, collection } = await setupCollectionSite(false);
    const res = await post("pages.publish", admin, {
      id: site.id,
      sources: [{ type: "collection", id: collection.id }],
    });
    expect(res.status).toEqual(200);
    const { accessCode } = (await res.json()).data;

    const pages = await publishedPages(site, accessCode);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    for (const page of pages) {
      expect(page.plaintext).toContain(
        page.pageKey === "index.html" ? "Alpha" : MARKER
      );
      expect(page.plaintext).not.toContain("data-pages-beacon");
      expect(page.plaintext).not.toContain("pages.ingest");
      expect(page.plaintext).not.toContain(site.ingestKey);
      // The plaintext is exactly the rendered page that was hashed.
      expect(sha256(page.plaintext)).toEqual(page.contentHash);
    }
  });

  it("adds exactly one beacon to every page when measurement is on", async () => {
    const { admin, site, collection } = await setupCollectionSite(true);
    const res = await post("pages.publish", admin, {
      id: site.id,
      sources: [{ type: "collection", id: collection.id }],
    });
    expect(res.status).toEqual(200);
    const { accessCode } = (await res.json()).data;

    const pages = await publishedPages(site, accessCode);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    for (const page of pages) {
      expect(page.plaintext.split(OPEN_TAG)).toHaveLength(2);
      const beacon = page.plaintext.slice(
        page.plaintext.indexOf(OPEN_TAG),
        page.plaintext.indexOf("</script>", page.plaintext.indexOf(OPEN_TAG)) +
          "</script>".length
      );
      expect(beacon).toContain(
        `(${JSON.stringify(endpoint())},${JSON.stringify(site.ingestKey)},${JSON.stringify(page.pageKey)})`
      );
      expect(page.plaintext.indexOf(OPEN_TAG)).toBeLessThan(
        page.plaintext.lastIndexOf("</body>")
      );
      // The gate a visitor sees before unlocking carries nothing of it.
      expect(page.gatePage).not.toContain("pages.ingest");
      expect(page.gatePage).not.toContain(site.ingestKey);
      expect(page.gatePage).not.toContain("data-pages-beacon");
      // The recorded hash is of the page before decoration.
      expect(sha256(page.plaintext.replace(beacon, ""))).toEqual(
        page.contentHash
      );
    }
  });

  it("keeps the beacon when the code is rotated", async () => {
    const { admin, site, collection } = await setupCollectionSite(true);
    const first = await post("pages.publish", admin, {
      id: site.id,
      sources: [{ type: "collection", id: collection.id }],
    });
    expect(first.status).toEqual(200);

    const res = await post("pages.rotate", admin, { id: site.id });
    expect(res.status).toEqual(200);
    const { accessCode } = (await res.json()).data;

    for (const page of await publishedPages(site, accessCode)) {
      expect(page.plaintext.split(OPEN_TAG)).toHaveLength(2);
      expect(page.plaintext).toContain(JSON.stringify(page.pageKey));
      expect(page.plaintext).toContain(JSON.stringify(site.ingestKey));
    }
  });

  it("follows the measurement switch of the site at publish time", async () => {
    const { admin, site, collection } = await setupCollectionSite(true);
    const first = await post("pages.publish", admin, {
      id: site.id,
      sources: [{ type: "collection", id: collection.id }],
    });
    const code = (await first.json()).data.accessCode;
    await site.update({ measurementEnabled: false });

    const res = await post("pages.publish", admin, {
      id: site.id,
      accessCode: code,
    });
    expect(res.status).toEqual(200);
    for (const page of await publishedPages(site, code)) {
      expect(page.plaintext).not.toContain("data-pages-beacon");
    }
  });
});

describe("chosen access codes", () => {
  const CHOSEN = "Our Quarterly Numbers 2026";
  const indexText = (site: PagesSite) =>
    store.text(`sites/${site.slug}/index.html`) ?? "";

  it("publishes with a chosen code and does not echo it", async () => {
    const { admin, site, document } = await setup();
    const res = await post("pages.publish", admin, {
      id: site.id,
      sources: docSource(document),
      newAccessCode: CHOSEN,
    });
    const body = await res.json();

    expect(res.status).toEqual(200);
    expect(body.data).not.toHaveProperty("accessCode");
    expect(JSON.stringify(body)).not.toContain(CHOSEN);
    expect(await verifyCode(CHOSEN, indexText(site))).toBe(true);

    const republish = await post("pages.publish", admin, {
      id: site.id,
      accessCode: CHOSEN,
    });
    expect(republish.status).toEqual(200);
  });

  it("refuses a short chosen code without echoing it or uploading", async () => {
    const { admin, site, document } = await setup();
    const res = await post("pages.publish", admin, {
      id: site.id,
      sources: docSource(document),
      newAccessCode: "short-one",
    });
    expect(res.status).toEqual(400);
    expect(JSON.stringify(await res.json())).not.toContain("short-one");
    expect(puts()).toEqual([]);
  });

  it("refuses a chosen code on a republish", async () => {
    const { admin, site, document } = await setup();
    const code = await publishFirst(admin, site, document);
    const mark = store.calls.length;
    const res = await post("pages.publish", admin, {
      id: site.id,
      accessCode: code,
      newAccessCode: CHOSEN,
    });
    expect(res.status).toEqual(400);
    expect((await res.json()).error).toEqual("new_code_not_applicable");
    expect(store.calls.slice(mark).filter((c) => c.startsWith("put "))).toEqual(
      []
    );
  });

  it("rotates to a chosen code", async () => {
    const { admin, site, document } = await setup();
    const oldCode = await publishFirst(admin, site, document);
    const res = await post("pages.rotate", admin, {
      id: site.id,
      newAccessCode: CHOSEN,
    });
    const body = await res.json();

    expect(res.status).toEqual(200);
    expect(body.data).not.toHaveProperty("accessCode");
    expect(await verifyCode(CHOSEN, indexText(site))).toBe(true);
    expect(await verifyCode(oldCode, indexText(site))).toBe(false);
  });
});

describe("unprotected sites", () => {
  async function setupPublic() {
    const context = await setup();
    await context.site.update({ gateType: "none" });
    return context;
  }

  it("publishes plain pages with no code and republishes without one", async () => {
    const { admin, site, document } = await setupPublic();
    const res = await post("pages.publish", admin, {
      id: site.id,
      sources: docSource(document),
    });
    const body = await res.json();

    expect(res.status).toEqual(200);
    expect(body.data).not.toHaveProperty("accessCode");
    expect(body.data.site.gateType).toEqual("none");
    const index = store.text(`sites/${site.slug}/index.html`) ?? "";
    expect(parseGatePage(index)).toBeNull();
    expect(index).toContain(MARKER);
    expect(index).toContain('<meta name="robots" content="noindex,nofollow">');

    const republish = await post("pages.publish", admin, { id: site.id });
    expect(republish.status).toEqual(200);
  });

  it("refuses rotation and a chosen code", async () => {
    const { admin, site, document } = await setupPublic();
    await post("pages.publish", admin, {
      id: site.id,
      sources: docSource(document),
    });

    const rotate = await post("pages.rotate", admin, { id: site.id });
    expect(rotate.status).toEqual(409);
    expect((await rotate.json()).error).toEqual("nothing_to_rotate");

    const chosen = await post("pages.publish", admin, {
      id: site.id,
      newAccessCode: "a-perfectly-good-code",
    });
    expect(chosen.status).toEqual(400);
    expect((await chosen.json()).error).toEqual("new_code_not_applicable");
  });
});
