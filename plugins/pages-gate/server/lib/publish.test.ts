import crypto from "node:crypto";
import { inspect } from "node:util";
import Logger from "@server/logging/Logger";
import { PagesPublication, PagesSite } from "@server/models";
import { PagesSiteStatus } from "@server/models/PagesSite";
import { sequelize } from "@server/storage/database";
import * as gate from "./gate";
import {
  AccessCodeRequiredError,
  EmptySiteError,
  IncorrectCodeError,
  InvalidCustomCodeError,
  NewCodeNotApplicableError,
  NoLivePageError,
  NothingToRotateError,
  publishSite,
} from "./publish";
import type { ObjectStore } from "./objectStore";
import type { RenderedPage } from "./renderPages";
import { buildUser } from "@server/test/factories";
import { buildPagesSite } from "../test/factories";
import { createMemoryStore, type MemoryStore } from "../test/memoryStore";

vi.mock("./gate", async (importOriginal) => {
  const actual = await importOriginal<typeof gate>();
  return {
    ...actual,
    createGate: vi.fn(actual.createGate),
    generateAccessCode: vi.fn(actual.generateAccessCode),
  };
});

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

vi.setConfig({ testTimeout: 60_000 });

const MARKER = "PLAINTEXT-MARKER-q7Zr";
const CODE_PATTERN = /^[a-hj-km-np-z2-9]{4}(-[a-hj-km-np-z2-9]{4}){3}$/;

function page(pageKey: string): RenderedPage {
  return {
    pageKey,
    title: pageKey,
    html: `<html><body>${MARKER} ${pageKey}</body></html>`,
    sourceType: "document",
    sourceId: crypto.randomUUID(),
  };
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Decrypts a gate page exactly as the browser would. */
function unlock(code: string, gateHtml: string): string {
  const parsed = gate.parseGatePage(gateHtml);
  if (!parsed) {
    throw new Error("not a gate page");
  }
  const key = crypto.pbkdf2Sync(
    gate.normalizeCode(code),
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

async function snapshot(site: PagesSite, store: MemoryStore) {
  const row = await PagesSite.findByPk(site.id, { rejectOnEmpty: true });
  const publications = await PagesPublication.findAll({
    where: { siteId: site.id },
    order: [["pageKey", "ASC"]],
  });
  return {
    site: row.toJSON(),
    publications: publications.map((p) => p.toJSON()),
    objects: store.keys().map((key) => [key, store.text(key)]),
  };
}

/** Resolves once another session is waiting on this site's row lock. */
async function waitForRowLockWaiter(siteId: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const [rows] = await sequelize.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
       AND query LIKE '%pages_sites%' AND query LIKE '%' || :siteId || '%'`,
      { replacements: { siteId } }
    );
    const [row] = rows as Array<{ n: number }>;
    if (row.n > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("no session waited on the site row lock");
}

async function firstPublish(pages = [page("index.html"), page("a.html")]) {
  const site = await buildPagesSite();
  const store = createMemoryStore();
  const result = await publishSite({
    site,
    pages,
    store,
    actorId: site.createdById,
  });
  return { site, store, result, code: result.issuedCode ?? "" };
}

describe("publishSite", () => {
  beforeEach(() => {
    vi.mocked(gate.createGate).mockClear();
  });

  it("issues a code on first publish and stores only encrypted pages", async () => {
    const pages = [page("a.html"), page("index.html"), page("dir/b.html")];
    const { site, store, result, code } = await firstPublish(pages);
    const prefix = `sites/${site.slug}/`;

    expect(code).toMatch(CODE_PATTERN);
    expect(result.indexKey).toBe(`${prefix}index.html`);
    expect(result.version).toBe(1);
    expect(result.publishedKeys.sort()).toEqual(
      [`${prefix}a.html`, `${prefix}dir/b.html`, `${prefix}index.html`].sort()
    );
    expect(store.keys()).toEqual(result.publishedKeys.sort());

    for (const key of store.keys()) {
      const text = store.text(key) ?? "";
      expect(gate.parseGatePage(text)).not.toBeNull();
      expect(text).not.toContain(MARKER);
      expect(text).toContain(`pg:${site.slug}:v1`);
      expect(store.meta(key)).toEqual({
        contentType: "text/html; charset=utf-8",
        cacheControl: "no-cache",
      });
    }
    expect(await gate.verifyCode(code, store.text(result.indexKey) ?? "")).toBe(
      true
    );
    expect(unlock(code, store.text(`${prefix}dir/b.html`) ?? "")).toBe(
      pages[2].html
    );

    const puts = store.calls.filter((c) => c.startsWith("put "));
    expect(puts).toHaveLength(3);
    expect(puts[puts.length - 1]).toBe(`put ${prefix}index.html`);

    await site.reload();
    expect(site.status).toBe(PagesSiteStatus.Published);
    expect(site.currentVersion).toBe(1);
    expect(site.codeVersion).toBe(1);

    const rows = await PagesPublication.findAll({ where: { siteId: site.id } });
    expect(rows).toHaveLength(3);
    for (const p of pages) {
      const row = rows.find((r) => r.pageKey === p.pageKey);
      expect(row?.contentHash).toBe(sha256(p.html));
      expect(row?.objectKey).toBe(prefix + p.pageKey);
      expect(row?.sourceId).toBe(p.sourceId);
      expect(row?.sourceType).toBe("document");
      expect(row?.publishedById).toBe(site.createdById);
    }
  });

  it("republishes with the right code, keeping the salt and removing stale objects", async () => {
    const index = page("index.html");
    const { site, store, code } = await firstPublish([
      index,
      page("a.html"),
      page("gone.html"),
    ]);
    const prefix = `sites/${site.slug}/`;
    const oldSalt = gate.parseGatePage(
      store.text(`${prefix}index.html`) ?? ""
    )?.salt;
    await store.put(`${prefix}leftover.html`, "old", {
      contentType: "text/html",
    });
    const before = await PagesPublication.findOne({
      where: { siteId: site.id, pageKey: "a.html" },
      rejectOnEmpty: true,
    });
    expect(before.title).toBe("a.html");

    const changed = {
      ...page("a.html"),
      title: "Renamed page",
      html: "<p>changed</p>",
    };
    const result = await publishSite({
      site,
      pages: [index, changed, page("new.html")],
      store,
      code: code.toUpperCase(),
      actorId: site.createdById,
    });

    expect(result.issuedCode).toBeUndefined();
    expect(result.version).toBe(2);
    expect(result.removedKeys.sort()).toEqual(
      [`${prefix}gone.html`, `${prefix}leftover.html`].sort()
    );
    expect(result.warnings).toEqual([]);
    expect(store.keys()).toEqual(
      [`${prefix}a.html`, `${prefix}index.html`, `${prefix}new.html`].sort()
    );
    const newSalt = gate.parseGatePage(
      store.text(`${prefix}index.html`) ?? ""
    )?.salt;
    expect(Buffer.from(newSalt ?? [])).toEqual(Buffer.from(oldSalt ?? []));
    expect(unlock(code, store.text(`${prefix}a.html`) ?? "")).toBe(
      "<p>changed</p>"
    );

    await site.reload();
    expect(site.currentVersion).toBe(2);
    expect(site.codeVersion).toBe(1);
    const rows = await PagesPublication.findAll({ where: { siteId: site.id } });
    expect(rows.map((r) => r.pageKey).sort()).toEqual([
      "a.html",
      "index.html",
      "new.html",
    ]);
    const after = rows.find((r) => r.pageKey === "a.html");
    expect(after?.id).toBe(before.id);
    expect(after?.contentHash).toBe(sha256("<p>changed</p>"));
    expect(after?.sourceId).toBe(changed.sourceId);
    expect(after?.title).toBe("Renamed page");
    expect(rows.find((r) => r.pageKey === "new.html")?.title).toBe("new.html");
  });

  it("refuses a republish without a code or with a wrong code, changing nothing", async () => {
    const { site, store, code } = await firstPublish();
    const before = await snapshot(site, store);
    const pages = [page("index.html"), page("other.html")];

    await expect(
      publishSite({ site, pages, store, actorId: site.createdById })
    ).rejects.toBeInstanceOf(AccessCodeRequiredError);
    expect(await snapshot(site, store)).toEqual(before);

    const wrong = gate.generateAccessCode();
    expect(wrong).not.toBe(code);
    await expect(
      publishSite({
        site,
        pages,
        store,
        code: wrong,
        actorId: site.createdById,
      })
    ).rejects.toBeInstanceOf(IncorrectCodeError);
    expect(await snapshot(site, store)).toEqual(before);
  });

  it("refuses a republish when the live index is missing or its salt is not 16 bytes", async () => {
    const { site, store, code } = await firstPublish();
    const indexKey = `sites/${site.slug}/index.html`;

    await store.delete(indexKey);
    const missing = publishSite({
      site,
      pages: [page("index.html")],
      store,
      code,
      actorId: site.createdById,
    });
    await expect(missing).rejects.toBeInstanceOf(NoLivePageError);
    await expect(missing).rejects.toThrow(/rotat/i);

    const shortSalt = await gate.createGate(code, {
      salt: new Uint8Array(8),
    });
    await store.put(
      indexKey,
      gate.renderGatePage({
        title: "x",
        storageKey: "pg:x:v1",
        salt: shortSalt.salt,
        blob: shortSalt.encryptPage("<p>x</p>"),
      }),
      { contentType: "text/html" }
    );
    await expect(
      publishSite({
        site,
        pages: [page("index.html")],
        store,
        code,
        actorId: site.createdById,
      })
    ).rejects.toBeInstanceOf(NoLivePageError);

    await store.put(indexKey, "<p>not a gate page</p>", {
      contentType: "text/html",
    });
    await expect(
      publishSite({
        site,
        pages: [page("index.html")],
        store,
        code,
        actorId: site.createdById,
      })
    ).rejects.toBeInstanceOf(NoLivePageError);
  });

  it("rolls back a republish whose upload fails, without leaking the code", async () => {
    const { site, store, code } = await firstPublish();
    const before = await snapshot(site, store);
    store.failOn("put", `sites/${site.slug}/b.html`);

    const error: unknown = await publishSite({
      site,
      pages: [page("index.html"), page("b.html")],
      store,
      code,
      actorId: site.createdById,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    const after = await snapshot(site, store);
    expect(after.site).toEqual(before.site);
    expect(after.publications).toEqual(before.publications);
    // The live index is untouched because it is uploaded last.
    expect(store.text(`sites/${site.slug}/index.html`)).toBe(
      before.objects.find(([k]) => k === `sites/${site.slug}/index.html`)?.[1]
    );
    // Every 4-character group is checked against the short message; the long
    // stack is checked for the whole code only, to avoid chance matches.
    for (const part of code.split("-")) {
      expect(String(error)).not.toContain(part);
    }
    expect((error as Error).stack ?? "").not.toContain(code);
    expect((error as Error).stack ?? "").not.toContain(code.replace(/-/g, ""));
  });

  it("rolls back a failed first publish and issues a fresh code on retry", async () => {
    const site = await buildPagesSite();
    const store = createMemoryStore();
    store.failOn("put", `sites/${site.slug}/a.html`);
    const pages = [page("index.html"), page("a.html")];

    await expect(
      publishSite({ site, pages, store, actorId: site.createdById })
    ).rejects.toThrow();
    await site.reload();
    expect(site.codeVersion).toBe(0);
    expect(site.currentVersion).toBe(0);
    expect(site.status).toBe(PagesSiteStatus.Draft);
    expect(await PagesPublication.count({ where: { siteId: site.id } })).toBe(
      0
    );
    expect(store.keys()).not.toContain(`sites/${site.slug}/index.html`);

    const retryStore = createMemoryStore();
    const result = await publishSite({
      site,
      pages,
      store: retryStore,
      actorId: site.createdById,
    });
    expect(result.issuedCode).toMatch(CODE_PATTERN);
    expect(
      await gate.verifyCode(
        result.issuedCode ?? "",
        retryStore.text(result.indexKey) ?? ""
      )
    ).toBe(true);
  });

  it("reports a failed cleanup delete as a warning, not an error", async () => {
    const { site, store, code } = await firstPublish([
      page("index.html"),
      page("old.html"),
    ]);
    store.failOn("delete", `sites/${site.slug}/old.html`);

    const result = await publishSite({
      site,
      pages: [page("index.html")],
      store,
      code,
      actorId: site.createdById,
    });

    expect(result.version).toBe(2);
    expect(result.removedKeys).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("1");
    for (const part of code.split("-")) {
      expect(result.warnings[0]).not.toContain(part);
    }
    await site.reload();
    expect(site.currentVersion).toBe(2);
  });

  it("derives the key once per publish and encrypts decorated output without changing the hash", async () => {
    const site = await buildPagesSite();
    const store = createMemoryStore();
    const pages = [page("index.html"), page("a.html"), page("b.html")];
    const decoratePage = (html: string, context: { pageKey: string }) =>
      html.replace("</body>", `<i>DECORATED-${context.pageKey}</i></body>`);

    const result = await publishSite({
      site,
      pages,
      store,
      actorId: site.createdById,
      decoratePage,
    });
    expect(gate.createGate).toHaveBeenCalledTimes(1);

    const code = result.issuedCode ?? "";
    const key = `sites/${site.slug}/a.html`;
    expect(store.text(key)).not.toContain("DECORATED");
    expect(unlock(code, store.text(key) ?? "")).toContain("DECORATED-a.html");
    const row = await PagesPublication.findOne({
      where: { siteId: site.id, pageKey: "a.html" },
      rejectOnEmpty: true,
    });
    expect(row.contentHash).toBe(sha256(pages[1].html));

    vi.mocked(gate.createGate).mockClear();
    await publishSite({
      site,
      pages,
      store,
      code,
      actorId: site.createdById,
    });
    expect(gate.createGate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["zero pages", []],
    ["no index", [page("a.html")]],
    ["a traversal key", [page("index.html"), page("../x.html")]],
    ["a duplicate key", [page("index.html"), page("a.html"), page("a.html")]],
  ])("refuses %s before touching the store", async (_name, pages) => {
    const site = await buildPagesSite();
    const store = createMemoryStore();
    await expect(
      publishSite({ site, pages, store, actorId: site.createdById })
    ).rejects.toThrow();
    expect(store.calls).toEqual([]);
    expect(gate.createGate).not.toHaveBeenCalled();
  });

  it("refuses zero pages with EmptySiteError", async () => {
    const site = await buildPagesSite();
    await expect(
      publishSite({
        site,
        pages: [],
        store: createMemoryStore(),
        actorId: site.createdById,
      })
    ).rejects.toBeInstanceOf(EmptySiteError);
  });

  it("serialises two concurrent first publishes of one site", async () => {
    const site = await buildPagesSite();
    const store = createMemoryStore();
    const pages = [page("index.html"), page("a.html")];

    const results = await Promise.allSettled([
      publishSite({ site, pages, store, actorId: site.createdById }),
      publishSite({ site, pages, store, actorId: site.createdById }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(AccessCodeRequiredError);

    const code = fulfilled[0].value.issuedCode ?? "";
    expect(code).toMatch(CODE_PATTERN);
    expect(
      await gate.verifyCode(
        code,
        store.text(`sites/${site.slug}/index.html`) ?? ""
      )
    ).toBe(true);
    expect(unlock(code, store.text(`sites/${site.slug}/a.html`) ?? "")).toBe(
      pages[1].html
    );
    await site.reload();
    expect(site.codeVersion).toBe(1);
    expect(site.currentVersion).toBe(1);
  });

  it("waits for the site row lock before resolving the gate or uploading", async () => {
    const site = await buildPagesSite();
    const store = createMemoryStore();
    let release = () => {};
    let locked = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const acquired = new Promise<void>((resolve) => (locked = resolve));
    const holder = sequelize.transaction(async (transaction) => {
      await PagesSite.findByPk(site.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      locked();
      await held;
    });
    await acquired;

    const publishing = publishSite({
      site,
      pages: [page("index.html")],
      store,
      actorId: site.createdById,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(gate.createGate).not.toHaveBeenCalled();
    expect(store.calls).toEqual([]);

    release();
    await holder;
    const result = await publishing;
    expect(result.issuedCode).toMatch(CODE_PATTERN);
  });

  it("skips cleanup when a newer publish has committed", async () => {
    const { site, store, code } = await firstPublish([
      page("index.html"),
      page("old.html"),
    ]);
    const mark = store.calls.length;

    const result = await publishSite({
      site,
      pages: [page("index.html")],
      store,
      code,
      actorId: site.createdById,
      onCommitted: async () => {
        await PagesSite.update(
          { currentVersion: 99 },
          { where: { id: site.id } }
        );
      },
    });

    expect(result.version).toBe(2);
    expect(result.removedKeys).toEqual([]);
    expect(result.warnings).toEqual([]);
    const after = store.calls.slice(mark);
    expect(after.filter((c) => /^(delete|list) /.test(c))).toEqual([]);
    expect(store.keys()).toContain(`sites/${site.slug}/old.html`);
  });

  it("holds the site lock during cleanup so a later publish cannot upload meanwhile", async () => {
    const { site, store, code } = await firstPublish([
      page("index.html"),
      page("a.html"),
    ]);
    let releaseList = () => {};
    let listEntered = () => {};
    const listGate = new Promise<void>((resolve) => (releaseList = resolve));
    const entered = new Promise<void>((resolve) => (listEntered = resolve));
    const blocking: ObjectStore = {
      ...store,
      async list(prefix) {
        listEntered();
        await listGate;
        return store.list(prefix);
      },
    };

    const first = publishSite({
      site,
      pages: [page("index.html")],
      store: blocking,
      code,
      actorId: site.createdById,
    });
    await entered;
    vi.mocked(gate.createGate).mockClear();
    const mark = store.calls.length;

    const second = publishSite({
      site,
      pages: [page("index.html"), page("a.html")],
      store,
      code,
      actorId: site.createdById,
    });
    await waitForRowLockWaiter(site.id);
    expect(gate.createGate).not.toHaveBeenCalled();
    expect(store.calls.slice(mark)).toEqual([]);

    releaseList();
    const [a, b] = await Promise.all([first, second]);
    expect(a.removedKeys).toEqual([`sites/${site.slug}/a.html`]);
    expect(b.version).toBe(3);
    expect(store.keys()).toEqual([
      `sites/${site.slug}/a.html`,
      `sites/${site.slug}/index.html`,
    ]);
  });

  it("turns a failed cleanup transaction into a warning and still returns the code", async () => {
    const site = await buildPagesSite();
    const store = createMemoryStore();
    let spy: { mockRestore(): void } | undefined;

    const result = await publishSite({
      site,
      pages: [page("index.html"), page("a.html")],
      store,
      actorId: site.createdById,
      onCommitted: async () => {
        spy = vi
          .spyOn(sequelize, "transaction")
          .mockRejectedValueOnce(new Error("database unavailable"));
      },
    });
    spy?.mockRestore();

    expect(result.version).toBe(1);
    expect(result.issuedCode).toMatch(CODE_PATTERN);
    expect(result.warnings).toHaveLength(1);
    for (const part of (result.issuedCode ?? "").split("-")) {
      expect(result.warnings[0]).not.toContain(part);
    }
    expect(
      await gate.verifyCode(
        result.issuedCode ?? "",
        store.text(result.indexKey) ?? ""
      )
    ).toBe(true);
    await site.reload();
    expect(site.codeVersion).toBe(1);
  });

  it("never logs, stores or reports the code", async () => {
    const consoleSpies = (
      ["log", "info", "warn", "error", "debug"] as const
    ).map((method) => vi.spyOn(console, method));
    const loggerSpies = (
      ["info", "debug", "silly", "warn", "error"] as const
    ).map((method) => vi.spyOn(Logger, method));

    const { site, store, result, code } = await firstPublish([
      page("index.html"),
      page("old.html"),
    ]);
    store.failOn("delete", `sites/${site.slug}/old.html`);
    const second = await publishSite({
      site,
      pages: [page("index.html")],
      store,
      code,
      actorId: site.createdById,
    });
    await publishSite({
      site,
      pages: [page("index.html")],
      store,
      code: "wrong",
      actorId: site.createdById,
    }).catch(() => undefined);

    const parts = [code, code.replace(/-/g, "")];
    const spied = [...consoleSpies, ...loggerSpies]
      .flatMap((spy) => spy.mock.calls)
      .map((args) => JSON.stringify(args.map(String)));
    const { issuedCode: _issued, ...firstRest } = result;
    const db = await snapshot(site, store);
    const surfaces = [
      ...spied,
      JSON.stringify(firstRest),
      JSON.stringify(second),
      JSON.stringify(db.site),
      JSON.stringify(db.publications),
    ];
    for (const surface of surfaces) {
      for (const part of parts) {
        expect(surface).not.toContain(part);
      }
    }
    for (const spy of [...consoleSpies, ...loggerSpies]) {
      spy.mockRestore();
    }
  });
});

describe("publishSite rotation", () => {
  const saltOf = (html: string | undefined) =>
    Buffer.from(gate.parseGatePage(html ?? "")?.salt ?? []).toString("base64");

  /** The codes generateAccessCode returned since the last mockClear. */
  const generatedCodes = () =>
    vi
      .mocked(gate.generateAccessCode)
      .mock.results.filter((r) => r.type === "return")
      .map((r) => String(r.value));

  beforeEach(() => {
    vi.mocked(gate.createGate).mockClear();
    vi.mocked(gate.generateAccessCode).mockClear();
  });

  it("issues a new code and salt, re-encrypts every page and drops stale ones", async () => {
    const {
      site,
      store,
      code: oldCode,
    } = await firstPublish([
      page("index.html"),
      page("a.html"),
      page("gone.html"),
    ]);
    const prefix = `sites/${site.slug}/`;
    const oldSalt = saltOf(store.text(`${prefix}index.html`));
    const actor = await buildUser({ teamId: site.teamId });
    const started = Date.now();

    const result = await publishSite({
      site,
      pages: [page("index.html"), page("a.html")],
      store,
      // Ignored: the administrator is replacing the code, not proving it.
      code: "wrong-wrong-wrong-wrong",
      actorId: actor.id,
      rotate: true,
    });

    const newCode = result.issuedCode ?? "";
    expect(newCode).toMatch(CODE_PATTERN);
    expect(newCode).not.toBe(oldCode);
    expect(result.version).toBe(2);
    expect(result.removedKeys).toEqual([`${prefix}gone.html`]);
    expect(store.keys()).toEqual([`${prefix}a.html`, `${prefix}index.html`]);
    for (const key of store.keys()) {
      const text = store.text(key) ?? "";
      expect(text).toContain(`pg:${site.slug}:v2`);
      expect(text).not.toContain(`pg:${site.slug}:v1`);
      expect(saltOf(text)).not.toBe(oldSalt);
      expect(await gate.verifyCode(newCode, text)).toBe(true);
      expect(await gate.verifyCode(oldCode, text)).toBe(false);
    }

    await site.reload();
    expect(site.status).toBe(PagesSiteStatus.Published);
    expect(site.codeVersion).toBe(2);
    expect(site.currentVersion).toBe(2);
    expect(site.rotatedById).toBe(actor.id);
    expect(site.rotatedAt?.getTime()).toBeGreaterThanOrEqual(started - 1000);
    expect(site.rotatedAt?.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const rows = await PagesPublication.findAll({ where: { siteId: site.id } });
    expect(rows.map((r) => r.pageKey).sort()).toEqual(["a.html", "index.html"]);
  });

  it("rotates when the live index object is missing, as NoLivePageError advises", async () => {
    const { site, store, code: oldCode } = await firstPublish();
    await store.delete(`sites/${site.slug}/index.html`);

    const result = await publishSite({
      site,
      pages: [page("index.html")],
      store,
      actorId: site.createdById,
      rotate: true,
    });

    expect(result.issuedCode).toMatch(CODE_PATTERN);
    expect(result.issuedCode).not.toBe(oldCode);
    expect(
      await gate.verifyCode(
        result.issuedCode ?? "",
        store.text(result.indexKey) ?? ""
      )
    ).toBe(true);
  });

  it("refuses to rotate a never-published site without touching the store", async () => {
    const site = await buildPagesSite();
    const store = createMemoryStore();

    await expect(
      publishSite({
        site,
        pages: [page("index.html")],
        store,
        actorId: site.createdById,
        rotate: true,
      })
    ).rejects.toBeInstanceOf(NothingToRotateError);
    expect(store.calls).toEqual([]);
    expect(gate.createGate).not.toHaveBeenCalled();
    await site.reload();
    expect(site.codeVersion).toBe(0);
    expect(site.rotatedAt).toBeNull();
  });

  it("refuses to rotate a site without a live index without touching the store", async () => {
    const site = await buildPagesSite();
    await site.update({ status: PagesSiteStatus.Published, codeVersion: 1 });
    const store = createMemoryStore();

    await expect(
      publishSite({
        site,
        pages: [page("index.html")],
        store,
        actorId: site.createdById,
        rotate: true,
      })
    ).rejects.toBeInstanceOf(NothingToRotateError);
    expect(store.calls).toEqual([]);
    expect(gate.createGate).not.toHaveBeenCalled();
    await site.reload();
    expect(site.codeVersion).toBe(1);
    expect(site.rotatedAt).toBeNull();
  });

  it("rolls back a failed rotation, keeps the old index, and a retry issues a fresh code", async () => {
    const {
      site,
      store,
      code: oldCode,
    } = await firstPublish([
      page("index.html"),
      page("a.html"),
      page("b.html"),
    ]);
    const before = await snapshot(site, store);
    const indexKey = `sites/${site.slug}/index.html`;
    let failing = true;
    const flaky: ObjectStore = {
      ...store,
      async put(key, body, options) {
        if (failing && key.endsWith("/b.html")) {
          throw new Error("memory store: injected put failure");
        }
        return store.put(key, body, options);
      },
    };
    const pages = [page("index.html"), page("a.html"), page("b.html")];

    const error: unknown = await publishSite({
      site,
      pages,
      store: flaky,
      actorId: site.createdById,
      rotate: true,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    const [failedCode] = generatedCodes();
    expect(failedCode).toMatch(CODE_PATTERN);
    const after = await snapshot(site, store);
    expect(after.site).toEqual(before.site);
    expect(after.publications).toEqual(before.publications);
    // a.html went up with the failed attempt's code; the index did not.
    expect(store.text(indexKey)).toBe(
      before.objects.find(([k]) => k === indexKey)?.[1]
    );
    expect(await gate.verifyCode(oldCode, store.text(indexKey) ?? "")).toBe(
      true
    );
    for (const code of [oldCode, failedCode]) {
      for (const part of code.split("-")) {
        expect(String(error)).not.toContain(part);
      }
      expect((error as Error).stack ?? "").not.toContain(code);
    }

    failing = false;
    const retry = await publishSite({
      site,
      pages,
      store: flaky,
      actorId: site.createdById,
      rotate: true,
    });
    const newCode = retry.issuedCode ?? "";
    expect(newCode).toMatch(CODE_PATTERN);
    expect(newCode).not.toBe(failedCode);
    expect(newCode).not.toBe(oldCode);
    for (const key of store.keys()) {
      const text = store.text(key) ?? "";
      expect(await gate.verifyCode(newCode, text)).toBe(true);
      expect(await gate.verifyCode(oldCode, text)).toBe(false);
      expect(await gate.verifyCode(failedCode, text)).toBe(false);
    }
    for (const part of [...oldCode.split("-"), ...newCode.split("-")]) {
      expect(JSON.stringify(retry.warnings)).not.toContain(part);
    }
    await site.reload();
    expect(site.codeVersion).toBe(2);
  });

  it("keeps the old index live when a database write fails mid-rotation", async () => {
    const { site, store, code: oldCode } = await firstPublish();
    const indexKey = `sites/${site.slug}/index.html`;
    const before = store.text(indexKey);
    const spy = vi
      .spyOn(PagesPublication, "destroy")
      .mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      publishSite({
        site,
        pages: [page("index.html"), page("a.html")],
        store,
        actorId: site.createdById,
        rotate: true,
      })
    ).rejects.toThrow("database unavailable");
    spy.mockRestore();

    // No reader is left facing an index under a code nobody was given.
    expect(store.text(indexKey)).toBe(before);
    expect(await gate.verifyCode(oldCode, before ?? "")).toBe(true);
    await site.reload();
    expect(site.codeVersion).toBe(1);
    expect(site.rotatedAt).toBeNull();
  });

  it("logs one line with ids and versions only, and never a code or salt", async () => {
    const { site, store, code: oldCode } = await firstPublish();
    const oldSalt = gate.parseGatePage(
      store.text(`sites/${site.slug}/index.html`) ?? ""
    )?.salt;
    const consoleSpies = (
      ["log", "info", "warn", "error", "debug"] as const
    ).map((method) => vi.spyOn(console, method));
    const loggerSpies = (
      ["info", "debug", "silly", "warn", "error", "fatal"] as const
    ).map((method) => vi.spyOn(Logger, method));

    const result = await publishSite({
      site,
      pages: [page("index.html")],
      store,
      code: oldCode,
      actorId: site.createdById,
      rotate: true,
    });
    const newCode = result.issuedCode ?? "";
    const newSalt = gate.parseGatePage(store.text(result.indexKey) ?? "")?.salt;

    const info = vi.mocked(Logger.info);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]).toEqual([
      "plugins",
      expect.any(String),
      {
        siteId: site.id,
        actorId: site.createdById,
        codeVersion: 2,
        currentVersion: 2,
      },
    ]);

    const secrets = [oldCode, newCode].flatMap((c) => [c, c.replace(/-/g, "")]);
    for (const salt of [oldSalt, newSalt]) {
      const bytes = Buffer.from(salt ?? []);
      secrets.push(bytes.toString("base64"), bytes.toString("hex"));
    }
    const logged = [...consoleSpies, ...loggerSpies]
      .flatMap((spy) => spy.mock.calls)
      .map((args) => JSON.stringify(args.map((a) => inspect(a, { depth: 10 }))))
      .join("\n");
    for (const secret of secrets) {
      expect(logged).not.toContain(secret);
    }
    for (const spy of [...consoleSpies, ...loggerSpies]) {
      spy.mockRestore();
    }
  });
});

describe("publishSite with a chosen code", () => {
  beforeEach(() => {
    vi.mocked(gate.createGate).mockClear();
    vi.mocked(gate.generateAccessCode).mockClear();
  });

  const CHOSEN = "Correct Horse Battery";

  it("uses the chosen code on first publish and never returns it", async () => {
    const site = await buildPagesSite();
    const store = createMemoryStore();
    const result = await publishSite({
      site,
      pages: [page("index.html"), page("a.html")],
      store,
      actorId: site.createdById,
      newCode: CHOSEN,
    });

    expect(result.issuedCode).toBeUndefined();
    expect(vi.mocked(gate.generateAccessCode)).not.toHaveBeenCalled();
    const index = store.text(result.indexKey) ?? "";
    expect(await gate.verifyCode(CHOSEN, index)).toBe(true);
    // Readers may type it in any case and with any spacing.
    expect(await gate.verifyCode("correcthorsebattery", index)).toBe(true);
    await site.reload();
    expect(site.codeVersion).toBe(1);
  });

  it("republishes with the chosen code as the current code", async () => {
    const site = await buildPagesSite();
    const store = createMemoryStore();
    const pages = [page("index.html")];
    await publishSite({
      site,
      pages,
      store,
      actorId: site.createdById,
      newCode: CHOSEN,
    });
    const result = await publishSite({
      site,
      pages,
      store,
      actorId: site.createdById,
      code: CHOSEN,
    });
    expect(result.issuedCode).toBeUndefined();
    expect(result.version).toBe(2);
  });

  it("rotates to a chosen code", async () => {
    const { site, store, code } = await firstPublish();
    const result = await publishSite({
      site,
      pages: [page("index.html"), page("a.html")],
      store,
      actorId: site.createdById,
      rotate: true,
      newCode: CHOSEN,
    });
    const index = store.text(result.indexKey) ?? "";
    expect(result.issuedCode).toBeUndefined();
    expect(await gate.verifyCode(CHOSEN, index)).toBe(true);
    expect(await gate.verifyCode(code, index)).toBe(false);
  });

  it("refuses a chosen code on a republish, changing nothing", async () => {
    const { site, store, code } = await firstPublish();
    const before = await snapshot(site, store);
    await expect(
      publishSite({
        site,
        pages: [page("index.html")],
        store,
        actorId: site.createdById,
        code,
        newCode: CHOSEN,
      })
    ).rejects.toBeInstanceOf(NewCodeNotApplicableError);
    expect(await snapshot(site, store)).toEqual(before);
  });

  it("refuses a short or non-ASCII chosen code before touching anything", async () => {
    for (const newCode of [
      "too short",
      "a b c d e f g h i j k",
      "ünïcödé-cödé-ünïcödé",
    ]) {
      const site = await buildPagesSite();
      const store = createMemoryStore();
      await expect(
        publishSite({
          site,
          pages: [page("index.html")],
          store,
          actorId: site.createdById,
          newCode,
        })
      ).rejects.toBeInstanceOf(InvalidCustomCodeError);
      expect(store.keys()).toEqual([]);
    }
  });
});

describe("publishSite for an unprotected site", () => {
  beforeEach(() => {
    vi.mocked(gate.createGate).mockClear();
    vi.mocked(gate.generateAccessCode).mockClear();
  });

  async function buildPublicSite() {
    return buildPagesSite({ gateType: "none" });
  }

  it("uploads plain pages marked noindex, with no code", async () => {
    const site = await buildPublicSite();
    const store = createMemoryStore();
    const pages = [page("index.html"), page("a.html")];
    pages[0].html = `<!DOCTYPE html><html><head><title>x</title></head><body>${MARKER}</body></html>`;
    const result = await publishSite({
      site,
      pages,
      store,
      actorId: site.createdById,
    });

    expect(result.issuedCode).toBeUndefined();
    expect(vi.mocked(gate.createGate)).not.toHaveBeenCalled();
    const index = store.text(result.indexKey) ?? "";
    expect(gate.parseGatePage(index)).toBeNull();
    expect(index).toBe(
      `<!DOCTYPE html><html><head><meta name="robots" content="noindex,nofollow"><title>x</title></head><body>${MARKER}</body></html>`
    );
    expect(store.text(`sites/${site.slug}/a.html`)).toContain(MARKER);
    await site.reload();
    expect(site.status).toBe(PagesSiteStatus.Published);
    expect(site.codeVersion).toBe(0);
  });

  it("republishes without a code", async () => {
    const site = await buildPublicSite();
    const store = createMemoryStore();
    const pages = [page("index.html")];
    await publishSite({ site, pages, store, actorId: site.createdById });
    const result = await publishSite({
      site,
      pages,
      store,
      actorId: site.createdById,
    });
    expect(result.version).toBe(2);
    expect(result.issuedCode).toBeUndefined();
  });

  it("refuses rotation and a chosen code", async () => {
    const site = await buildPublicSite();
    const store = createMemoryStore();
    const pages = [page("index.html")];
    await publishSite({ site, pages, store, actorId: site.createdById });
    await expect(
      publishSite({
        site,
        pages,
        store,
        actorId: site.createdById,
        rotate: true,
      })
    ).rejects.toBeInstanceOf(NothingToRotateError);
    await expect(
      publishSite({
        site,
        pages,
        store,
        actorId: site.createdById,
        newCode: "a-perfectly-good-code",
      })
    ).rejects.toBeInstanceOf(NewCodeNotApplicableError);
  });
});
