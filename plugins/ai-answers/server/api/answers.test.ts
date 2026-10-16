import { http, HttpResponse } from "msw";
import { vi } from "vitest";
import { TeamPreference } from "@shared/types";
import { SearchQuery } from "@server/models";
import {
  buildAdmin,
  buildCollection,
  buildDocument,
  buildUser,
} from "@server/test/factories";
import { server as mswServer } from "@server/test/msw";
import { getTestServer } from "@server/test/support";

// Plugins are loaded with a runtime require, which vi.mock cannot reach, so the
// model is stubbed at the HTTP layer. `create` receives the request body.
const create = vi.fn();

const server = getTestServer();

describe("#documents.answerQuestion", () => {
  it("requires authentication", async () => {
    const res = await server.post("/api/documents.answerQuestion", {
      body: { query: "holiday policy" },
    });
    expect(res.status).toEqual(401);
  });

  it("is refused when AI answers are not enabled for the workspace", async () => {
    const user = await buildUser();
    const res = await server.post("/api/documents.answerQuestion", user, {
      body: { query: "holiday policy" },
    });
    expect(res.status).toEqual(403);
  });

  it("rejects an empty query", async () => {
    const user = await buildUser();
    user.team.setPreference(TeamPreference.AIAnswers, true);
    await user.team.save();
    const res = await server.post("/api/documents.answerQuestion", user, {
      body: { query: "   " },
    });
    expect(res.status).toEqual(400);
  });

  describe("when the workspace preference is off", () => {
    beforeEach(() => {
      create.mockReset();
      mswServer.use(
        http.post("https://api.anthropic.com/v1/messages", async () =>
          HttpResponse.json(await create())
        )
      );
    });

    it("validates the body before checking the preference (400, not 403)", async () => {
      const user = await buildUser();
      const res = await server.post("/api/documents.answerQuestion", user, {
        body: { query: "   " },
      });
      expect(res.status).toEqual(400);
      expect(create).not.toHaveBeenCalled();
    });

    it("never calls the model and returns 403 for a valid query", async () => {
      const user = await buildUser();
      const res = await server.post("/api/documents.answerQuestion", user, {
        body: { query: "How many days of holiday?" },
      });
      expect(res.status).toEqual(403);
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe("when enabled", () => {
    async function setup() {
      const user = await buildUser();
      user.team.setPreference(TeamPreference.AIAnswers, true);
      await user.team.save();
      const collection = await buildCollection({
        teamId: user.teamId,
        userId: user.id,
      });
      const document = await buildDocument({
        teamId: user.teamId,
        userId: user.id,
        collectionId: collection.id,
        title: "Holidays",
        text: "# Leave\nEmployees receive twenty five days of holiday.",
      });
      return { user, document };
    }

    beforeEach(() => {
      create.mockReset();
      mswServer.use(
        http.post(
          "https://api.anthropic.com/v1/messages",
          async ({ request }) => {
            try {
              return HttpResponse.json(await create(await request.json()));
            } catch {
              return HttpResponse.json({ type: "error" }, { status: 400 });
            }
          }
        )
      );
    });

    it("returns a cited answer without creating a search query", async () => {
      const { user, document } = await setup();
      create.mockResolvedValue({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: "Twenty five days.",
            citations: [
              {
                type: "search_result_location",
                cited_text: "Employees receive twenty five days of holiday.",
                source: document.url,
                title: document.title,
                search_result_index: 0,
                start_block_index: 0,
                end_block_index: 1,
              },
            ],
          },
        ],
      });

      const before = await SearchQuery.count({ where: { userId: user.id } });
      const res = await server.post("/api/documents.answerQuestion", user, {
        body: { query: "How many days of holiday?" },
      });
      const body = await res.json();

      expect(res.status).toEqual(200);
      expect(body.answer).toEqual("Twenty five days.");
      expect(body.citations[0].documentId).toEqual(document.id);
      expect(body.documents[0].id).toEqual(document.id);
      // The call is not logged as a search query at all.
      expect(body.search).toBeUndefined();
      expect(await SearchQuery.count({ where: { userId: user.id } })).toEqual(
        before
      );
    });

    it("returns a null answer without calling the model when nothing matches", async () => {
      const { user } = await setup();
      const res = await server.post("/api/documents.answerQuestion", user, {
        body: { query: "zxqv wjkl" },
      });
      const body = await res.json();
      expect(res.status).toEqual(200);
      expect(body.answer).toBeNull();
      expect(body.citations).toEqual([]);
      expect(create).not.toHaveBeenCalled();
    });

    it("degrades to documents only when generation fails", async () => {
      const { user, document } = await setup();
      create.mockRejectedValue(new Error("boom"));

      const res = await server.post("/api/documents.answerQuestion", user, {
        body: { query: "How many days of holiday?" },
      });
      const body = await res.json();

      expect(create).toHaveBeenCalledTimes(1);
      expect(res.status).toEqual(200);
      expect(body.answer).toBeNull();
      expect(body.citations).toEqual([]);
      expect(body.documents.map((d: { id: string }) => d.id)).toContain(
        document.id
      );
      expect(await SearchQuery.count({ where: { userId: user.id } })).toEqual(
        0
      );
    });

    it("never sends another user's private text to the model", async () => {
      const { user } = await setup();
      const owner = await buildUser({ teamId: user.teamId });
      const secret = await buildCollection({
        teamId: user.teamId,
        userId: owner.id,
        permission: null,
      });
      const secretDocument = await buildDocument({
        teamId: user.teamId,
        userId: owner.id,
        collectionId: secret.id,
        text: "# Pay\nThe secret salary figure is nine hundred thousand.",
      });
      create.mockResolvedValue({ stop_reason: "end_turn", content: [] });

      const res = await server.post("/api/documents.answerQuestion", user, {
        body: { query: "holiday salary figure" },
      });
      const body = await res.json();

      // The asker's own document matches, so the model is called with it.
      expect(res.status).toEqual(200);
      expect(create).toHaveBeenCalledTimes(1);
      const sent = JSON.stringify(create.mock.calls[0][0]);
      expect(sent).toContain("twenty five days");
      expect(sent).not.toContain("nine hundred thousand");
      expect(body.documents.map((d: { id: string }) => d.id)).not.toContain(
        secretDocument.id
      );
    });

    it("never sends text from an AI-excluded collection to the model, even for an admin", async () => {
      const { user } = await setup();
      const admin = await buildAdmin({ teamId: user.teamId });
      const excluded = await buildCollection({
        teamId: user.teamId,
        userId: admin.id,
        aiExcluded: true,
      });
      const excludedDocument = await buildDocument({
        teamId: user.teamId,
        userId: admin.id,
        collectionId: excluded.id,
        text: "# Leave\nThe excluded holiday bonus is nine hundred thousand.",
      });
      create.mockResolvedValue({ stop_reason: "end_turn", content: [] });

      const res = await server.post("/api/documents.answerQuestion", admin, {
        body: { query: "holiday days bonus" },
      });
      const body = await res.json();

      expect(res.status).toEqual(200);
      expect(create).toHaveBeenCalledTimes(1);
      const sent = JSON.stringify(create.mock.calls[0][0]);
      expect(sent).toContain("twenty five days");
      expect(sent).not.toContain("nine hundred thousand");
      expect(body.documents.map((d: { id: string }) => d.id)).not.toContain(
        excludedDocument.id
      );
    });

    it("redacts planted secrets in documents and the query before the model", async () => {
      const { user } = await setup();
      // Synthetic values assembled at runtime so no real-looking secret is committed.
      const docToken = "gh" + "p_" + "Q".repeat(36);
      const docPassword = "Plant" + "ed9pass";
      const keyBody = "MIIEpAIBAAKCAQEA" + "K".repeat(40);
      const queryKey = "sk-ant-" + "api03-" + "Z".repeat(30);
      // The document url carries a lowercased title slug, so check that too.
      const titleToken = "gl" + "pat-" + "Wq7".repeat(8);
      const keyBlock = [
        "-----BEGIN " + "PRIVATE KEY-----",
        keyBody,
        "-----END " + "PRIVATE KEY-----",
      ].join("\n");
      await buildDocument({
        teamId: user.teamId,
        userId: user.id,
        title: `Holiday admin ${titleToken}`,
        text: `# Holiday admin\nThe holiday tool uses ${docToken} to sync.\n\npassword: ${docPassword}\n\n\`\`\`\n${keyBlock}\n\`\`\``,
      });
      create.mockResolvedValue({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: "Holiday tool sync.",
            citations: [
              {
                type: "search_result_location",
                cited_text: "The holiday tool uses",
                search_result_index: 0,
                start_block_index: 0,
                end_block_index: 1,
              },
            ],
          },
        ],
      });

      const res = await server.post("/api/documents.answerQuestion", user, {
        body: { query: `How many days of holiday? My key is ${queryKey}` },
      });
      const body = await res.json();

      expect(res.status).toEqual(200);
      expect(body.answer).toEqual("Holiday tool sync.");
      expect(create).toHaveBeenCalledTimes(1);
      const sent = JSON.stringify(create.mock.calls[0][0]);
      expect(sent).toContain("holiday tool uses");
      expect(sent).toContain("[REDACTED:private_key]");
      expect(sent).toContain("[REDACTED:assignment]");
      expect(sent).toContain("[REDACTED:vcs_token]");
      expect(sent).toContain("[REDACTED:provider_key]");
      expect(sent.toLowerCase()).not.toContain("wq7wq7wq7");
      for (const secret of [
        docToken,
        docPassword,
        keyBody,
        queryKey,
        titleToken,
      ]) {
        expect(sent).not.toContain(secret);
      }
    });
  });
});
