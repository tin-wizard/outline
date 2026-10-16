import { InvalidSlugError } from "./keys";
import { artifactPrefix, createArtifactStore } from "./artifactStore";
import { createMemoryStore } from "../test/memoryStore";

const opts = { contentType: "text/html" };

const unsafePaths = [
  "../x",
  "/abs",
  "a//b",
  "a%2fb",
  "a\\b",
  "",
  "..",
  ".",
  "./a",
  "a/./b",
  "a/../b",
  "a/..",
  "a/",
  "%2e%2e/x",
  "..%2fx",
  "a\0b",
  "a\nb",
  "x".repeat(201),
];

describe("artifactPrefix", () => {
  it("builds artifacts/<slug>/", () => {
    expect(artifactPrefix("demo-1")).toBe("artifacts/demo-1/");
  });
  it("rejects invalid or reserved slugs", () => {
    expect(() => artifactPrefix("../x")).toThrow(InvalidSlugError);
    expect(() => artifactPrefix("AB")).toThrow(InvalidSlugError);
    expect(() => artifactPrefix("robots.txt")).toThrow(InvalidSlugError);
    expect(() => artifactPrefix("")).toThrow(InvalidSlugError);
    expect(() => artifactPrefix("demo/x")).toThrow(InvalidSlugError);
  });
});

describe("createArtifactStore", () => {
  it("rejects an invalid slug before touching the store", () => {
    const raw = createMemoryStore();
    expect(() => createArtifactStore(raw, "../sites")).toThrow(
      InvalidSlugError
    );
    expect(raw.calls).toEqual([]);
  });

  it("writes under the prefix with the given metadata", async () => {
    const raw = createMemoryStore();
    await createArtifactStore(raw, "demo").put("css/a.css", "a{}", {
      contentType: "text/css",
      cacheControl: "public, max-age=300",
    });
    expect(raw.keys()).toEqual(["artifacts/demo/css/a.css"]);
    expect(raw.meta("artifacts/demo/css/a.css")).toEqual({
      contentType: "text/css",
      cacheControl: "public, max-age=300",
    });
  });

  it.each(unsafePaths)(
    "refuses to write or delete adversarial path %j and touches nothing",
    async (p) => {
      const raw = createMemoryStore({ "sites/demo/index.html": "keep" });
      const artifact = createArtifactStore(raw, "demo");
      await expect(artifact.put(p, "x", opts)).rejects.toThrow();
      await expect(artifact.delete(p)).rejects.toThrow();
      expect(raw.calls).toEqual([]);
      expect(raw.keys()).toEqual(["sites/demo/index.html"]);
    }
  );

  it("deletes one file under its own prefix only", async () => {
    const raw = createMemoryStore({
      "artifacts/demo/index.html": "1",
      "artifacts/demo-two/index.html": "2",
    });
    await createArtifactStore(raw, "demo").delete("index.html");
    expect(raw.calls).toEqual(["delete artifacts/demo/index.html"]);
    expect(raw.keys()).toEqual(["artifacts/demo-two/index.html"]);
  });

  it("lists only its own files, as relative paths", async () => {
    const raw = createMemoryStore({
      "artifacts/demo/index.html": "1",
      "artifacts/demo/js/a.js": "2",
      "artifacts/demo-two/index.html": "3",
      "sites/demo/index.html": "4",
    });
    expect((await createArtifactStore(raw, "demo").list()).sort()).toEqual([
      "index.html",
      "js/a.js",
    ]);
  });

  it("lists with the exact trailing-slash prefix", async () => {
    const raw = createMemoryStore({ "artifacts/demo-two/index.html": "3" });
    expect(await createArtifactStore(raw, "demo").list()).toEqual([]);
    expect(raw.calls).toEqual(["list artifacts/demo/"]);
  });

  it("removeAll deletes only its own prefix", async () => {
    const raw = createMemoryStore({
      "artifacts/demo/index.html": "1",
      "artifacts/demo/js/a.js": "2",
      "artifacts/demo-two/index.html": "3",
      "sites/demo/index.html": "4",
    });
    expect(await createArtifactStore(raw, "demo").removeAll()).toBe(2);
    expect(raw.keys()).toEqual([
      "artifacts/demo-two/index.html",
      "sites/demo/index.html",
    ]);
  });

  it("removeAll refuses when the store still lists files afterwards", async () => {
    const raw = createMemoryStore({ "artifacts/demo/index.html": "1" });
    // A store whose delete silently does nothing: the verification must catch it.
    raw.delete = async () => undefined;
    await expect(createArtifactStore(raw, "demo").removeAll()).rejects.toThrow(
      "Some published files could not be removed"
    );
  });

  it("list throws if the store returns a key outside the prefix", async () => {
    const raw = createMemoryStore();
    raw.list = async () => ["sites/other/index.html"];
    await expect(createArtifactStore(raw, "demo").list()).rejects.toThrow();
  });

  it("list throws for a sibling slug key the store wrongly returns", async () => {
    const raw = createMemoryStore();
    raw.list = async () => ["artifacts/demo-two/index.html", "artifacts/demo"];
    await expect(createArtifactStore(raw, "demo").list()).rejects.toThrow();
  });

  it("removeAll deletes nothing when the listing has a foreign key", async () => {
    const raw = createMemoryStore({ "sites/demo/index.html": "4" });
    raw.list = async () => ["artifacts/demo/a.html", "sites/demo/index.html"];
    await expect(
      createArtifactStore(raw, "demo").removeAll()
    ).rejects.toThrow();
    expect(raw.calls).toEqual([]);
    expect(raw.keys()).toEqual(["sites/demo/index.html"]);
  });

  it.each([
    { "artifacts/demo/../../sites/x": "1" },
    {
      "artifacts/demo/index.html": "1",
      "artifacts/demo/../../sites/x": "2",
      "artifacts/demo/js/a.js": "3",
    },
    { "artifacts/demo/a%2f..": "1", "artifacts/demo/index.html": "2" },
  ])(
    "removeAll deletes nothing when a listed name is unsafe (%j)",
    async (seed) => {
      const raw = createMemoryStore(seed);
      await expect(
        createArtifactStore(raw, "demo").removeAll()
      ).rejects.toThrow(
        "Artifact has files with unsafe names; remove them manually"
      );
      expect(raw.calls.filter((c) => c.startsWith("delete"))).toEqual([]);
      expect(raw.keys()).toEqual(Object.keys(seed).sort());
    }
  );

  it("removeAll deletes and counts a folder marker equal to the prefix", async () => {
    const raw = createMemoryStore({
      "artifacts/demo/": "",
      "artifacts/demo/index.html": "1",
    });
    expect(await createArtifactStore(raw, "demo").removeAll()).toBe(2);
    expect(raw.keys()).toEqual([]);
  });

  it("removeAll counts duplicate listed keys once", async () => {
    const raw = createMemoryStore({
      "artifacts/demo/index.html": "1",
      "artifacts/demo/js/a.js": "2",
    });
    const listOnce = raw.list;
    raw.list = async (prefix) => {
      const keys = await listOnce(prefix);
      return [...keys, ...keys];
    };
    expect(await createArtifactStore(raw, "demo").removeAll()).toBe(2);
    expect(raw.calls.filter((c) => c.startsWith("delete"))).toEqual([
      "delete artifacts/demo/index.html",
      "delete artifacts/demo/js/a.js",
    ]);
    expect(raw.keys()).toEqual([]);
  });
});
