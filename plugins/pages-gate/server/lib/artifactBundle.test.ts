import { deflateRawSync } from "node:zlib";
import {
  BUNDLE_LIMITS,
  BundleError,
  contentTypeForPath,
  readBundle,
} from "./artifactBundle";

interface RawEntry {
  name: string;
  data: string | Buffer;
  /** Compression method; 0 stores `data`, 8 deflates it. */
  method?: number;
  /** General purpose bit flag (bit 0 marks the entry encrypted). */
  flags?: number;
  /** External attributes; a unix mode lives in the high 16 bits. */
  externalAttributes?: number;
  /** Overrides the uncompressed size written in both headers. */
  declaredSize?: number;
}

/** Builds a zip from raw entries. Entry names are written verbatim. */
function zipEntries(entries: RawEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data);
    const method = entry.method ?? 0;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const size = entry.declaredSize ?? raw.length;
    const nameBuf = Buffer.from(entry.name);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(entry.flags ?? 0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(entry.externalAttributes ?? 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

/** Builds a stored (uncompressed) zip. Entry names are written verbatim. */
function zip(entries: Record<string, string | Buffer>): Buffer {
  return zipEntries(
    Object.entries(entries).map(([name, data]) => ({ name, data }))
  );
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return ~c >>> 0;
}

describe("readBundle", () => {
  it("accepts a single html file as index.html", async () => {
    const out = await readBundle("demo.html", Buffer.from("<h1>hi</h1>"));
    expect(out.kind).toBe("html");
    expect(out.files).toHaveLength(1);
    expect(out.files[0]).toMatchObject({
      path: "index.html",
      contentType: "text/html; charset=utf-8",
    });
  });

  it("accepts a zip with index.html and assets", async () => {
    const out = await readBundle(
      "site.zip",
      zip({ "index.html": "<p>x</p>", "css/app.css": "a{}" })
    );
    expect(out.kind).toBe("bundle");
    expect(out.files.map((f) => f.path).sort()).toEqual([
      "css/app.css",
      "index.html",
    ]);
  });

  it("rejects a zip without index.html", async () => {
    await expect(
      readBundle("s.zip", zip({ "a.html": "x" }))
    ).rejects.toBeInstanceOf(BundleError);
  });

  it.each(["../evil.html", "/abs.html", "a\\b.html", "ok/../../x.html"])(
    "rejects traversal entry %j",
    async (name) => {
      await expect(
        readBundle("s.zip", zip({ "index.html": "x", [name]: "y" }))
      ).rejects.toBeInstanceOf(BundleError);
    }
  );

  it("rejects an extension outside the allowlist", async () => {
    await expect(
      readBundle("s.zip", zip({ "index.html": "x", "run.exe": "MZ" }))
    ).rejects.toBeInstanceOf(BundleError);
  });

  it("rejects too many files", async () => {
    const entries: Record<string, string> = { "index.html": "x" };
    for (let i = 0; i < BUNDLE_LIMITS.files; i++) {
      entries[`f${i}.txt`] = "x";
    }
    await expect(readBundle("s.zip", zip(entries))).rejects.toBeInstanceOf(
      BundleError
    );
  });

  it("rejects a file over the per-file limit", async () => {
    const big = Buffer.alloc(BUNDLE_LIMITS.fileBytes + 1, 1);
    await expect(
      readBundle("s.zip", zip({ "index.html": "x", "big.txt": big }))
    ).rejects.toBeInstanceOf(BundleError);
  });

  it("rejects unknown top-level file types", async () => {
    await expect(readBundle("a.pdf", Buffer.from("x"))).rejects.toBeInstanceOf(
      BundleError
    );
  });

  it("rejects an empty html upload", async () => {
    await expect(readBundle("a.html", Buffer.alloc(0))).rejects.toBeInstanceOf(
      BundleError
    );
  });

  it("returns the inflated bytes of a deflated entry", async () => {
    const out = await readBundle(
      "s.zip",
      zipEntries([{ name: "index.html", data: "<p>deflated</p>", method: 8 }])
    );
    expect(out.files[0].body.toString()).toBe("<p>deflated</p>");
  });

  it("rejects a duplicate entry name", async () => {
    await expect(
      readBundle(
        "s.zip",
        zipEntries([
          { name: "index.html", data: "a" },
          { name: "index.html", data: "b" },
        ])
      )
    ).rejects.toBeInstanceOf(BundleError);
  });

  it("rejects names that collide case-insensitively", async () => {
    await expect(
      readBundle(
        "s.zip",
        zipEntries([
          { name: "index.html", data: "a" },
          { name: "Index.html", data: "b" },
        ])
      )
    ).rejects.toBeInstanceOf(BundleError);
  });

  it("rejects a symlink entry", async () => {
    await expect(
      readBundle(
        "s.zip",
        zipEntries([
          { name: "index.html", data: "x" },
          {
            name: "link.txt",
            data: "/etc/passwd",
            externalAttributes: (0o120777 << 16) >>> 0,
          },
        ])
      )
    ).rejects.toBeInstanceOf(BundleError);
  });

  it("rejects an encrypted entry", async () => {
    await expect(
      readBundle(
        "s.zip",
        zipEntries([{ name: "index.html", data: "x", flags: 1 }])
      )
    ).rejects.toBeInstanceOf(BundleError);
  });

  it("rejects an unsupported compression method", async () => {
    await expect(
      readBundle(
        "s.zip",
        zipEntries([{ name: "index.html", data: "x", method: 12 }])
      )
    ).rejects.toBeInstanceOf(BundleError);
  });

  it("rejects an entry that inflates past its declared size", async () => {
    const bomb = Buffer.alloc(BUNDLE_LIMITS.fileBytes + 1024);
    await expect(
      readBundle(
        "s.zip",
        zipEntries([
          { name: "index.html", data: "x" },
          { name: "bomb.txt", data: bomb, method: 8, declaredSize: 10 },
        ])
      )
    ).rejects.toBeInstanceOf(BundleError);
  });

  it.each(["a\u0001.txt", `${"a/".repeat(100)}x.txt`])(
    "rejects an unsafe path %j with a BundleError",
    async (name) => {
      // flag 0x800 marks the name UTF-8; without it yauzl decodes CP437
      // and maps control bytes to printable glyphs.
      await expect(
        readBundle(
          "s.zip",
          zipEntries([
            { name: "index.html", data: "x" },
            { name, data: "y", flags: 0x800 },
          ])
        )
      ).rejects.toBeInstanceOf(BundleError);
    }
  );

  it.each([
    ["empty", Buffer.alloc(0)],
    ["garbage", Buffer.from("not a zip at all")],
    ["truncated", zip({ "index.html": "x" }).subarray(0, 40)],
    [
      "bad local header offset",
      (() => {
        const buf = zip({ "index.html": "x" });
        // central directory starts after the 30 + 10 + 1 byte local entry
        buf.writeUInt32LE(9999, 41 + 42);
        return buf;
      })(),
    ],
  ])("rejects a malformed zip (%s) with a BundleError", async (_, bytes) => {
    await expect(readBundle("s.zip", bytes)).rejects.toBeInstanceOf(
      BundleError
    );
  });
});

describe("contentTypeForPath", () => {
  it("maps allowed extensions and returns undefined otherwise", () => {
    expect(contentTypeForPath("a/b.CSS")).toBe("text/css; charset=utf-8");
    expect(contentTypeForPath("run.exe")).toBeUndefined();
    expect(contentTypeForPath("x.constructor")).toBeUndefined();
  });
});
