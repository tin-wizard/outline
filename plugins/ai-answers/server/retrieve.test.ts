import {
  buildAdmin,
  buildCollection,
  buildDocument,
  buildTeam,
  buildUser,
} from "@server/test/factories";
import { retrieveSources } from "./retrieve";

describe("retrieveSources", () => {
  it("returns sections from documents the user can read", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const collection = await buildCollection({
      teamId: team.id,
      userId: user.id,
    });
    await buildDocument({
      teamId: team.id,
      userId: user.id,
      collectionId: collection.id,
      title: "Holidays",
      text: "# Leave\nEmployees receive twenty five days of holiday.",
    });

    const sources = await retrieveSources(user, {
      query: "How many days of holiday do employees get?",
    });

    expect(sources.length).toEqual(1);
    expect(sources[0].document.title).toEqual("Holidays");
    expect(sources[0].sections.join("\n")).toContain("twenty five days");
  });

  it("never returns text from a private collection the user cannot access", async () => {
    const team = await buildTeam();
    const owner = await buildUser({ teamId: team.id });
    const outsider = await buildUser({ teamId: team.id });
    const secret = await buildCollection({
      teamId: team.id,
      userId: owner.id,
      permission: null,
    });
    await buildDocument({
      teamId: team.id,
      userId: owner.id,
      collectionId: secret.id,
      title: "Salaries",
      text: "# Pay\nThe secret salary figure is nine hundred thousand.",
    });
    const query = { query: "What is the secret salary figure?" };

    // control: the document is findable by someone with access, so an empty
    // result for the outsider can only come from permissions.
    const ownerSources = await retrieveSources(owner, query);
    expect(ownerSources.map((s) => s.document.title)).toEqual(["Salaries"]);

    const sources = await retrieveSources(outsider, query);

    expect(sources).toEqual([]);
  });

  describe("unreadable scope filters", () => {
    async function setupPrivate() {
      const team = await buildTeam();
      const owner = await buildUser({ teamId: team.id });
      const outsider = await buildUser({ teamId: team.id });
      const secret = await buildCollection({
        teamId: team.id,
        userId: owner.id,
        permission: null,
      });
      const document = await buildDocument({
        teamId: team.id,
        userId: owner.id,
        collectionId: secret.id,
        text: "# Pay\nThe secret salary figure is nine hundred thousand.",
      });
      return { outsider, secret, document };
    }

    it("rejects a documentId the user cannot read", async () => {
      const { outsider, document } = await setupPrivate();
      const result = retrieveSources(outsider, {
        query: "salary figure",
        documentId: document.id,
      });
      await expect(result).rejects.toThrow();
      await expect(result).rejects.toMatchObject({
        status: 403,
        id: "authorization_error",
      });
    });

    it("rejects a collectionId the user cannot read", async () => {
      const { outsider, secret } = await setupPrivate();
      const result = retrieveSources(outsider, {
        query: "salary figure",
        collectionId: secret.id,
      });
      await expect(result).rejects.toThrow();
      await expect(result).rejects.toMatchObject({
        status: 403,
        id: "authorization_error",
      });
    });
  });

  it("returns nothing when the question has no keywords", async () => {
    const user = await buildUser();
    expect(await retrieveSources(user, { query: "what is the?" })).toEqual([]);
  });

  it("does not return documents from another team", async () => {
    const other = await buildDocument({
      title: "Elsewhere",
      text: "# Holiday\nholiday policy of another team",
    });
    const user = await buildUser();
    const sources = await retrieveSources(user, { query: "holiday policy" });
    expect(sources.map((s) => s.document.id)).not.toContain(other.id);
  });

  it("respects the collectionId filter", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const a = await buildCollection({ teamId: team.id, userId: user.id });
    const b = await buildCollection({ teamId: team.id, userId: user.id });
    await buildDocument({
      teamId: team.id,
      userId: user.id,
      collectionId: a.id,
      text: "# A\nparking rules for staff",
    });
    await buildDocument({
      teamId: team.id,
      userId: user.id,
      collectionId: b.id,
      text: "# B\nparking rules for visitors",
    });

    const sources = await retrieveSources(user, {
      query: "parking rules",
      collectionId: a.id,
    });

    expect(sources.length).toEqual(1);
    expect(sources[0].document.collectionId).toEqual(a.id);
  });
});

describe("retrieveSources with AI-excluded collections", () => {
  async function setup() {
    const team = await buildTeam();
    const admin = await buildAdmin({ teamId: team.id });
    const excluded = await buildCollection({
      teamId: team.id,
      userId: admin.id,
      aiExcluded: true,
    });
    const normal = await buildCollection({
      teamId: team.id,
      userId: admin.id,
    });
    await buildDocument({
      teamId: team.id,
      userId: admin.id,
      collectionId: excluded.id,
      title: "Board minutes",
      text: "# Merger\nThe merger codename is bluefin.",
    });
    await buildDocument({
      teamId: team.id,
      userId: admin.id,
      collectionId: normal.id,
      title: "Handbook",
      text: "# Merger\nThe merger policy is published openly.",
    });
    return { admin, excluded };
  }

  it("never returns documents from an excluded collection, even for an admin", async () => {
    const { admin } = await setup();

    const sources = await retrieveSources(admin, { query: "merger codename" });

    expect(sources.map((s) => s.document.title)).toEqual(["Handbook"]);
  });

  it("restores retrieval when the exclusion is turned off", async () => {
    const { admin, excluded } = await setup();
    await excluded.update({ aiExcluded: false });

    const sources = await retrieveSources(admin, { query: "merger codename" });

    expect(sources.map((s) => s.document.title).sort()).toEqual([
      "Board minutes",
      "Handbook",
    ]);
  });

  it("is not starved of results by many excluded matches", async () => {
    const { admin, excluded } = await setup();
    for (let i = 0; i < 6; i++) {
      await buildDocument({
        teamId: admin.teamId,
        userId: admin.id,
        collectionId: excluded.id,
        title: `Merger memo ${i}`,
        text: "# Merger\nMerger merger merger codename notes.",
      });
    }

    const sources = await retrieveSources(admin, { query: "merger codename" });

    expect(sources.map((s) => s.document.title)).toEqual(["Handbook"]);
  });
});

describe("retrieveSources hygiene", () => {
  async function setup() {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const collection = await buildCollection({
      teamId: team.id,
      userId: user.id,
    });
    const add = (title: string, text: string, collectionId = collection.id) =>
      buildDocument({
        teamId: team.id,
        userId: user.id,
        collectionId,
        title,
        text,
      });
    return { team, user, collection, add };
  }

  it("finds a document from a path-style query", async () => {
    const { user, add } = await setup();
    await add(
      "Tools",
      "# Tools\nThe mvanhorn/cli-printing-press repository prints labels."
    );

    const sources = await retrieveSources(user, {
      query: "mvanhorn/cli-printing-press",
    });

    expect(sources.map((s) => s.document.title)).toEqual(["Tools"]);
  });

  it("prefers documents matching every keyword when enough exist", async () => {
    const { user, add } = await setup();
    await add("Both A", "# A\nparking permits for visitors");
    await add("Both B", "# B\nvisitors parking permits explained");
    await add("Only parking", "# C\nparking parking parking parking");

    const sources = await retrieveSources(user, {
      query: "parking permits visitors",
    });

    expect(sources.map((s) => s.document.title).sort()).toEqual([
      "Both A",
      "Both B",
    ]);
  });

  it("falls back to any keyword when fewer than two documents match all", async () => {
    const { user, add } = await setup();
    await add("Both", "# A\nparking permits for visitors");
    await add("Only parking", "# C\nparking is available");

    const sources = await retrieveSources(user, {
      query: "parking permits visitors",
    });

    expect(sources.map((s) => s.document.title).sort()).toEqual([
      "Both",
      "Only parking",
    ]);
  });

  it("finds a document by a near title when full text finds nothing", async () => {
    const { user, add } = await setup();
    await add("ReleaseChecklist2024", "# Steps\nBring a laptop.");

    const sources = await retrieveSources(user, {
      query: "What is the release checklist?",
    });

    expect(sources.map((s) => s.document.title)).toEqual([
      "ReleaseChecklist2024",
    ]);
  });

  it("does not match on a single common word in the title fallback", async () => {
    const { user, add } = await setup();
    await add("ReleaseChecklist2024", "# Steps\nBring a laptop.");

    const sources = await retrieveSources(user, {
      query: "release schedule dates",
    });

    expect(sources).toEqual([]);
  });

  it("never returns an unreadable document through the title fallback", async () => {
    const { team, user, add } = await setup();
    const outsider = await buildUser({ teamId: team.id });
    const secret = await buildCollection({
      teamId: team.id,
      userId: user.id,
      permission: null,
    });
    await add("ReleaseChecklist2024", "# Steps\nBring a laptop.", secret.id);
    const query = { query: "What is the release checklist?" };

    // control: the owner reaches it through the same fallback path.
    expect((await retrieveSources(user, query)).length).toEqual(1);
    expect(await retrieveSources(outsider, query)).toEqual([]);
  });

  it("applies AI exclusion to the title fallback", async () => {
    const { team, user, add } = await setup();
    const excluded = await buildCollection({
      teamId: team.id,
      userId: user.id,
      aiExcluded: true,
    });
    await add("ReleaseChecklist2024", "# Steps\nBring a laptop.", excluded.id);

    const sources = await retrieveSources(user, {
      query: "What is the release checklist?",
    });

    expect(sources).toEqual([]);
  });
});

describe("retrieveSources fallback hardening", () => {
  async function setup() {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const collection = await buildCollection({
      teamId: team.id,
      userId: user.id,
    });
    const add = (title: string, text: string, collectionId = collection.id) =>
      buildDocument({
        teamId: team.id,
        userId: user.id,
        collectionId,
        title,
        text,
      });
    return { team, user, collection, add };
  }

  it("does not return unrelated documents for a compound-only query", async () => {
    const { user, add } = await setup();
    await add("Unrelated one", "# A\nsomething else entirely");
    await add("Unrelated two", "# B\nnothing to see here");

    expect(await retrieveSources(user, { query: "v1.2.3" })).toEqual([]);
  });

  it("does not match filler words inside longer title words", async () => {
    const { user, add } = await setup();
    await add("Project plan document", "# A\nunrelated");

    expect(
      await retrieveSources(user, { query: "HOW DO WE GET AN ID" })
    ).toEqual([]);
  });

  it("scopes the title fallback to collectionId", async () => {
    const { team, user, collection, add } = await setup();
    const other = await buildCollection({ teamId: team.id, userId: user.id });
    await add("ReleaseChecklist2024", "# Steps\nBring a laptop.");
    await add("ReleaseChecklist2025", "# Steps\nBring a laptop.", other.id);

    const sources = await retrieveSources(user, {
      query: "What is the release checklist?",
      collectionId: collection.id,
    });

    expect(sources.map((s) => s.document.title)).toEqual([
      "ReleaseChecklist2024",
    ]);
  });

  it("does not count excluded documents towards enough results", async () => {
    const { team, user, add } = await setup();
    const excluded = await buildCollection({
      teamId: team.id,
      userId: user.id,
      aiExcluded: true,
    });
    await add("Hidden A", "# A\nparking permits visitors", excluded.id);
    await add("Hidden B", "# B\nparking permits visitors", excluded.id);
    await add("Open", "# C\nparking is available");

    const sources = await retrieveSources(user, {
      query: "parking permits visitors",
    });

    expect(sources.map((s) => s.document.title)).toEqual(["Open"]);
  });

  it("stops when the signal is aborted", async () => {
    const { user, add } = await setup();
    await add("Open", "# C\nparking is available");
    const controller = new AbortController();
    controller.abort();

    await expect(
      retrieveSources(user, { query: "parking permits" }, controller.signal)
    ).rejects.toThrow();
  });
});
