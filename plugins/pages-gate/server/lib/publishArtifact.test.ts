import { randomBytes } from "node:crypto";
import { ValidationError } from "@server/errors";
import { PagesSite } from "@server/models";
import { PagesSiteKind, PagesSiteStatus } from "@server/models/PagesSite";
import { buildAdmin, buildTeam, buildUser } from "@server/test/factories";
import { buildPagesSite } from "../test/factories";
import { type MemoryStore, createMemoryStore } from "../test/memoryStore";
import { publishArtifact } from "./publishArtifact";

vi.setConfig({ testTimeout: 60_000 });

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

let store: MemoryStore;
const storeFactory = () => store;
beforeEach(() => {
  store = createMemoryStore();
});

describe("publishArtifact", () => {
  it("publishes a single html file for an admin", async () => {
    const admin = await buildAdmin();
    const slug = uniqueSlug("fn-demo");
    const { site, fileCount } = await publishArtifact({
      user: admin,
      slug,
      fileName: "demo.html",
      readBytes: async () => Buffer.from("<h1>hi</h1>"),
      storeFactory,
    });
    expect(site.kind).toBe(PagesSiteKind.Artifact);
    expect(site.status).toBe(PagesSiteStatus.Published);
    expect(fileCount).toBe(1);
    expect(store.keys()).toEqual([`artifacts/${slug}/index.html`]);
  });

  it("never reads the upload for a non-admin and touches nothing", async () => {
    const admin = await buildAdmin();
    const member = await buildUser({ teamId: admin.teamId });
    const readBytes = vi.fn(async () => Buffer.from("x"));
    const slug = uniqueSlug("fn-nope");
    await expect(
      publishArtifact({
        user: member,
        slug,
        fileName: "demo.html",
        readBytes,
        storeFactory,
      })
    ).rejects.toMatchObject({ status: 403 });
    // An invalid slug gets the same 403, never a slug-format error.
    await expect(
      publishArtifact({
        user: member,
        slug: "../x",
        fileName: "demo.html",
        readBytes,
        storeFactory,
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(readBytes).not.toHaveBeenCalled();
    expect(store.calls).toEqual([]);
    expect(await PagesSite.findOne({ where: { slug } })).toBeNull();
  });

  it("never reads the upload for a pages site's or another team's slug, with the same message", async () => {
    const admin = await buildAdmin();
    const pagesSlug = uniqueSlug("fn-taken-pages");
    await buildPagesSite({ teamId: admin.teamId, slug: pagesSlug });
    const otherTeam = await buildTeam();
    const other = await buildPagesSite({
      teamId: otherTeam.id,
      kind: PagesSiteKind.Artifact,
      slug: uniqueSlug("fn-taken-other"),
    });
    const readBytes = vi.fn(async () => Buffer.from("x"));
    const attempt = (slug: string) =>
      publishArtifact({
        user: admin,
        slug,
        fileName: "demo.html",
        readBytes,
        storeFactory,
      }).catch((err: Error) => err);
    const a = await attempt(pagesSlug);
    const b = await attempt(other.slug);
    expect(a).toMatchObject({ status: 400 });
    expect(b).toMatchObject({ status: 400 });
    expect(a instanceof Error && a.message).toBe(
      b instanceof Error && b.message
    );
    expect(readBytes).not.toHaveBeenCalled();
    expect(store.calls).toEqual([]);
  });

  it("generates a random slug and republishing it replaces files and bumps the version", async () => {
    const admin = await buildAdmin();
    const first = await publishArtifact({
      user: admin,
      fileName: "a.zip",
      readBytes: async () => zip({ "index.html": "1", "old.js": "2" }),
      storeFactory,
    });
    const { slug } = first.site;
    expect(slug).toMatch(/^[0-9a-f]{16}$/);
    const second = await publishArtifact({
      user: admin,
      slug,
      fileName: "b.zip",
      readBytes: async () => zip({ "index.html": "new" }),
      storeFactory,
    });
    expect(store.keys()).toEqual([`artifacts/${slug}/index.html`]);
    expect(store.text(`artifacts/${slug}/index.html`)).toBe("new");
    expect(second.site.currentVersion).toBe(first.site.currentVersion + 1);
  });

  it("turns a bundle error into a 400 and leaves no site row", async () => {
    const admin = await buildAdmin();
    const slug = uniqueSlug("fn-evil");
    await expect(
      publishArtifact({
        user: admin,
        slug,
        fileName: "evil.zip",
        readBytes: async () => zip({ "index.html": "x", "../evil.html": "y" }),
        storeFactory,
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(store.keys()).toEqual([]);
    expect(await PagesSite.count({ where: { slug } })).toBe(0);
  });

  it("writes nothing when reading the upload fails", async () => {
    const admin = await buildAdmin();
    const slug = uniqueSlug("fn-read-fail");
    await expect(
      publishArtifact({
        user: admin,
        slug,
        fileName: "demo.html",
        readBytes: async () => {
          throw ValidationError("The file is too large");
        },
        storeFactory,
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(await PagesSite.count({ where: { slug } })).toBe(0);
    expect(store.calls).toEqual([]);
  });

  it("leaves a draft site when a put fails", async () => {
    const admin = await buildAdmin();
    const slug = uniqueSlug("fn-half");
    store.failOn("put", `artifacts/${slug}/index.html`);
    await expect(
      publishArtifact({
        user: admin,
        slug,
        fileName: "demo.html",
        readBytes: async () => Buffer.from("x"),
        storeFactory,
      })
    ).rejects.toThrow();
    expect((await PagesSite.findOne({ where: { slug } }))?.status).toBe(
      PagesSiteStatus.Draft
    );
  });
});
