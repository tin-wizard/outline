import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { KeyOutsideSiteError } from "./keys";
import {
  createGuardedStore,
  createR2Client,
  createR2Store,
  type ObjectStore,
} from "./objectStore";
import { createMemoryStore } from "../test/memoryStore";

// The global test setup mocks the SDK; these tests need the real client config.
vi.unmock("@aws-sdk/client-s3");

const ACCOUNT = "0123456789abcdef0123456789abcdef";

describe("createR2Client", () => {
  const config = {
    accountId: ACCOUNT,
    accessKeyId: "id",
    secretAccessKey: "s",
  };

  it("targets the R2 endpoint with region auto and WHEN_REQUIRED checksums", async () => {
    const client = createR2Client(config);
    expect(await client.config.region()).toBe("auto");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe(`${ACCOUNT}.r2.cloudflarestorage.com`);
    expect(endpoint?.protocol).toBe("https:");
    expect(await client.config.requestChecksumCalculation()).toBe(
      "WHEN_REQUIRED"
    );
    expect(await client.config.responseChecksumValidation()).toBe(
      "WHEN_REQUIRED"
    );
  });

  it.each(["abc", `${ACCOUNT.slice(0, 31)}/`, `${ACCOUNT}\n`])(
    "throws for account id %j",
    (accountId) => {
      expect(() => createR2Client({ ...config, accountId })).toThrow();
    }
  );
});

describe("createR2Store", () => {
  const setup = (respond: (command: unknown) => unknown = () => ({})) => {
    const sent: unknown[] = [];
    const send = vi.fn(async (command: unknown) => {
      sent.push(command);
      const result = respond(command);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    });
    // The fake only needs `send`, which is all createR2Store may use.
    const store = createR2Store({ client: { send } as never, bucket: "b" });
    return { store, sent };
  };

  it("puts with bucket, key, content type and cache control", async () => {
    const { store, sent } = setup();
    await store.put("sites/foo/index.html", "hi", {
      contentType: "text/html",
      cacheControl: "no-store",
    });
    const command = sent[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: "b",
      Key: "sites/foo/index.html",
      Body: "hi",
      ContentType: "text/html",
      CacheControl: "no-store",
    });
    expect(command.input).not.toHaveProperty("ACL");
  });

  it("gets bytes, returns null for NoSuchKey and rethrows other errors", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const ok = setup(() => ({
      Body: { transformToByteArray: async () => bytes },
    }));
    expect(await ok.store.get("k")).toEqual(bytes);
    const command = ok.sent[0] as GetObjectCommand;
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toMatchObject({ Bucket: "b", Key: "k" });

    const missing = Object.assign(new Error("gone"), { name: "NoSuchKey" });
    expect(await setup(() => missing).store.get("k")).toBeNull();

    const denied = Object.assign(new Error("no"), { name: "AccessDenied" });
    await expect(setup(() => denied).store.get("k")).rejects.toBe(denied);
  });

  it("deletes with DeleteObject", async () => {
    const { store, sent } = setup();
    await store.delete("k");
    const command = sent[0] as DeleteObjectCommand;
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toMatchObject({ Bucket: "b", Key: "k" });
  });

  it("lists across three pages", async () => {
    const pages = [
      {
        Contents: [{ Key: "p/a" }],
        IsTruncated: true,
        NextContinuationToken: "t1",
      },
      {
        Contents: [{ Key: "p/b" }],
        IsTruncated: true,
        NextContinuationToken: "t2",
      },
      { Contents: [{ Key: "p/c" }], IsTruncated: false },
    ];
    const { store, sent } = setup(() => pages.shift());
    expect(await store.list("p/")).toEqual(["p/a", "p/b", "p/c"]);
    const inputs = sent.map((c) => {
      expect(c).toBeInstanceOf(ListObjectsV2Command);
      return (c as ListObjectsV2Command).input;
    });
    expect(inputs.map((i) => i.ContinuationToken)).toEqual([
      undefined,
      "t1",
      "t2",
    ]);
    expect(inputs[0]).toMatchObject({ Bucket: "b", Prefix: "p/" });
  });

  it("handles an empty listing", async () => {
    const { store } = setup(() => ({ IsTruncated: false }));
    expect(await store.list("p/")).toEqual([]);
  });

  it("throws when a truncated page has no continuation token", async () => {
    const { store } = setup(() => ({
      Contents: [{ Key: "p/a" }],
      IsTruncated: true,
    }));
    await expect(store.list("p/")).rejects.toThrow(/truncated/);
  });

  it("throws when the continuation token repeats", async () => {
    const { store, sent } = setup(() => ({
      Contents: [{ Key: "p/a" }],
      IsTruncated: true,
      NextContinuationToken: "same",
    }));
    await expect(store.list("p/")).rejects.toThrow(/truncated/);
    expect(sent).toHaveLength(2);
  });
});

describe("createGuardedStore", () => {
  const foreign = [
    "sites/other/index.html",
    "sites/",
    "sites/foo/../other/x.html",
    "index.html",
    "sites/Foo/index.html",
  ];

  it("validates the slug at construction", () => {
    expect(() => createGuardedStore(createMemoryStore(), "../x")).toThrow();
  });

  it.each(foreign)(
    "refuses put, get and delete of %j before the inner store",
    async (key) => {
      const inner = createMemoryStore();
      const store = createGuardedStore(inner, "foo");
      await expect(
        store.put(key, "x", { contentType: "text/html" })
      ).rejects.toBeInstanceOf(KeyOutsideSiteError);
      await expect(store.get(key)).rejects.toBeInstanceOf(KeyOutsideSiteError);
      await expect(store.delete(key)).rejects.toBeInstanceOf(
        KeyOutsideSiteError
      );
      expect(inner.calls).toEqual([]);
    }
  );

  it.each(["sites/other/", "sites/", "", "sites/foo", "sites/Foo/"])(
    "refuses list of %j before the inner store",
    async (prefix) => {
      const inner = createMemoryStore();
      const store = createGuardedStore(inner, "foo");
      await expect(store.list(prefix)).rejects.toBeInstanceOf(
        KeyOutsideSiteError
      );
      expect(inner.calls).toEqual([]);
    }
  );

  it("passes in-site operations through", async () => {
    const inner = createMemoryStore();
    const store = createGuardedStore(inner, "foo");
    await store.put("sites/foo/a.html", "A", { contentType: "text/html" });
    expect(await store.list("sites/foo/")).toEqual(["sites/foo/a.html"]);
    expect(
      new TextDecoder().decode(
        (await store.get("sites/foo/a.html")) ?? undefined
      )
    ).toBe("A");
    await store.delete("sites/foo/a.html");
    expect(inner.keys()).toEqual([]);
  });

  it("throws, not filters, when the inner list returns a foreign key", async () => {
    const inner = createMemoryStore({
      "sites/foo/a.html": "a",
      "sites/other/x.html": "x",
    });
    const leaky: ObjectStore = { ...inner, list: async () => inner.keys() };
    const store = createGuardedStore(leaky, "foo");
    await expect(store.list("sites/foo/")).rejects.toBeInstanceOf(
      KeyOutsideSiteError
    );
  });

  it("removeAll deletes only the site and leaves a similarly named site", async () => {
    const inner = createMemoryStore({
      "sites/foo/index.html": "1",
      "sites/foo/assets/a.js": "2",
      "sites/foo-bar/index.html": "3",
    });
    const store = createGuardedStore(inner, "foo");
    expect(await store.removeAll()).toBe(2);
    expect(inner.keys()).toEqual(["sites/foo-bar/index.html"]);
  });

  it("removeAll stops at the first failing delete and rethrows", async () => {
    const inner = createMemoryStore({
      "sites/foo/a.html": "1",
      "sites/foo/b.html": "2",
      "sites/foo/c.html": "3",
    });
    inner.failOn("delete", "sites/foo/b.html");
    const store = createGuardedStore(inner, "foo");
    await expect(store.removeAll()).rejects.toThrow("injected delete failure");
    expect(inner.keys()).toEqual(["sites/foo/b.html", "sites/foo/c.html"]);
  });
});
