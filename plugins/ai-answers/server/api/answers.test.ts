import { http, HttpResponse } from "msw";
import { vi } from "vitest";
import { TeamPreference } from "@shared/types";
import { SearchQuery } from "@server/models";
import {
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

    it("returns a cited answer and records it", async () => {
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

      const res = await server.post("/api/documents.answerQuestion", user, {
        body: { query: "How many days of holiday?" },
      });
      const body = await res.json();

      expect(res.status).toEqual(200);
      expect(body.search.answer).toEqual("Twenty five days.");
      expect(body.citations[0].documentId).toEqual(document.id);
      expect(body.documents[0].id).toEqual(document.id);
      const logged = await SearchQuery.findOne({ where: { userId: user.id } });
      expect(logged?.answer).toEqual("Twenty five days.");
    });

    it("returns a null answer without calling the model when nothing matches", async () => {
      const { user } = await setup();
      const res = await server.post("/api/documents.answerQuestion", user, {
        body: { query: "zxqv wjkl" },
      });
      const body = await res.json();
      expect(res.status).toEqual(200);
      expect(body.search.answer).toBeNull();
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
      expect(body.search.answer).toBeNull();
      expect(body.citations).toEqual([]);
      expect(body.documents.map((d: { id: string }) => d.id)).toContain(
        document.id
      );
      const logged = await SearchQuery.findOne({ where: { userId: user.id } });
      expect(logged).not.toBeNull();
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
  });
});
