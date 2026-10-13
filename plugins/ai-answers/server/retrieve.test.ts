import {
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
