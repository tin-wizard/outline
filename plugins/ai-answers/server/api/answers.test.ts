import { http, HttpResponse } from "msw";
import { vi } from "vitest";
import { TeamPreference } from "@shared/types";
import { AIAnswerUsage, SearchQuery } from "@server/models";
import {
  buildAdmin,
  buildCollection,
  buildDocument,
  buildUser,
} from "@server/test/factories";
import { server as mswServer } from "@server/test/msw";
import { getTestServer } from "@server/test/support";
import Redis from "@server/storage/redis";
import { acquireSlot, releaseSlot } from "../usage";

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

    describe("metering and limits", () => {
      const reply = (
        document: { url: string; title: string },
        usage?: object
      ) => ({
        stop_reason: "end_turn",
        ...(usage ? { usage } : {}),
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
      const ask = (user: Parameters<typeof server.post>[1]) =>
        server.post("/api/documents.answerQuestion", user, {
          body: { query: "How many days of holiday?" },
        });
      const spendRow = (teamId: string, costMicroUsd: number) =>
        AIAnswerUsage.create({
          teamId,
          userId: null,
          model: "claude-sonnet-5-5",
          inputTokens: 0,
          outputTokens: 0,
          costMicroUsd: String(costMicroUsd),
          outcome: "answered",
          droppedSegments: 0,
          durationMs: 0,
        });

      it("answers under budget and records tokens and cost", async () => {
        const { user, document } = await setup();
        create.mockResolvedValue(
          reply(document, { input_tokens: 1000, output_tokens: 100 })
        );
        const body = await (await ask(user)).json();
        expect(body.answer).toEqual("Twenty five days.");

        const rows = await AIAnswerUsage.findAll({
          where: { teamId: user.teamId },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].outcome).toEqual("answered");
        expect(rows[0].inputTokens).toEqual(1000);
        expect(rows[0].outputTokens).toEqual(100);
        expect(BigInt(rows[0].costMicroUsd) > 0n).toEqual(true);
        expect(rows[0].userId).toEqual(user.id);
      });

      it("over budget returns documents with a null answer and never calls the model", async () => {
        const { user, document } = await setup();
        await spendRow(user.teamId, 25_000_000);
        create.mockResolvedValue(
          reply(document, { input_tokens: 1, output_tokens: 1 })
        );

        const res = await ask(user);
        const body = await res.json();
        expect(res.status).toEqual(200);
        expect(body.answer).toBeNull();
        expect(body.citations).toEqual([]);
        expect(body.documents.map((d: { id: string }) => d.id)).toContain(
          document.id
        );
        expect(body.policies).toBeDefined();
        expect(create).not.toHaveBeenCalled();

        const blocked = await AIAnswerUsage.findAll({
          where: { teamId: user.teamId, outcome: "budget_blocked" },
        });
        expect(blocked).toHaveLength(1);
        expect(blocked[0].costMicroUsd).toEqual("0");
      });

      it("another workspace's spend does not block this one", async () => {
        const { user, document } = await setup();
        const other = await buildUser();
        await spendRow(other.teamId, 99_000_000);
        create.mockResolvedValue(
          reply(document, { input_tokens: 1, output_tokens: 1 })
        );
        expect((await (await ask(user)).json()).answer).toEqual(
          "Twenty five days."
        );
      });

      it("blocks the call beyond three concurrent ones, then allows it once a slot is freed", async () => {
        const { user, document } = await setup();
        create.mockResolvedValue(
          reply(document, { input_tokens: 1, output_tokens: 1 })
        );
        const held = [
          await acquireSlot(user.teamId),
          await acquireSlot(user.teamId),
          await acquireSlot(user.teamId),
        ] as string[];

        const blocked = await (await ask(user)).json();
        expect(blocked.answer).toBeNull();
        expect(blocked.documents).toHaveLength(1);
        expect(create).not.toHaveBeenCalled();

        await releaseSlot(user.teamId, held[0]);
        const allowed = await (await ask(user)).json();
        expect(allowed.answer).toEqual("Twenty five days.");
        expect(create).toHaveBeenCalledTimes(1);

        // The request released its own slot: two are still held, so one is free.
        const again = await acquireSlot(user.teamId);
        expect(again).not.toBeNull();
        for (const token of [held[1], held[2], again as string]) {
          await releaseSlot(user.teamId, token);
        }
      });

      it("fails closed when the budget lookup throws: no model call", async () => {
        const { user, document } = await setup();
        create.mockResolvedValue(
          reply(document, { input_tokens: 1, output_tokens: 1 })
        );
        const spy = vi
          .spyOn(AIAnswerUsage, "sum")
          .mockRejectedValue(new Error("db down"));
        try {
          const res = await ask(user);
          const body = await res.json();
          expect(res.status).toEqual(200);
          expect(body.answer).toBeNull();
          expect(body.documents).toHaveLength(1);
          expect(create).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
      });

      it("records a conservative estimate, not zero, when usage is missing (labelled by result)", async () => {
        const { user, document } = await setup();
        create.mockResolvedValue(reply(document));
        await ask(user);
        const [row] = await AIAnswerUsage.findAll({
          where: { teamId: user.teamId },
        });
        expect(row.outcome).toEqual("answered");
        expect(row.outputTokens).toEqual(1024);
        expect(row.inputTokens).toBeGreaterThan(0);
        expect(BigInt(row.costMicroUsd) > 0n).toEqual(true);
      });

      it("records a conservative estimate when the provider call fails", async () => {
        const { user } = await setup();
        create.mockRejectedValue(new Error("boom"));
        await ask(user);
        const [row] = await AIAnswerUsage.findAll({
          where: { teamId: user.teamId },
        });
        expect(row.outcome).toEqual("error");
        expect(BigInt(row.costMicroUsd) > 0n).toEqual(true);
      });

      it("makes exactly one upstream request when Anthropic returns a 500", async () => {
        const { user } = await setup();
        let requests = 0;
        mswServer.use(
          http.post("https://api.anthropic.com/v1/messages", () => {
            requests++;
            return HttpResponse.json({ type: "error" }, { status: 500 });
          })
        );
        const body = await (await ask(user)).json();
        expect(body.answer).toBeNull();
        expect(requests).toEqual(1);
      });

      it("records abstention as no_answer, not dropped", async () => {
        const { user } = await setup();
        create.mockResolvedValue({
          stop_reason: "end_turn",
          usage: { input_tokens: 500, output_tokens: 5 },
          content: [{ type: "text", text: "NO_ANSWER" }],
        });
        await ask(user);
        const [row] = await AIAnswerUsage.findAll({
          where: { teamId: user.teamId },
        });
        expect(row.outcome).toEqual("no_answer");
      });

      it("frees every slot after the provider throws", async () => {
        const { user } = await setup();
        create.mockRejectedValue(new Error("boom"));
        await ask(user);
        const tokens: Array<string | null> = [];
        for (let i = 0; i < 3; i++) {
          tokens.push(await acquireSlot(user.teamId));
        }
        expect(tokens.every(Boolean)).toEqual(true);
        for (const token of tokens) {
          await releaseSlot(user.teamId, token as string);
        }
      });

      it("blocks later requests after usage could not be recorded", async () => {
        const { user, document } = await setup();
        create.mockResolvedValue(
          reply(document, { input_tokens: 1, output_tokens: 1 })
        );
        const spy = vi
          .spyOn(AIAnswerUsage, "create")
          .mockRejectedValueOnce(new Error("db down"));
        try {
          const first = await (await ask(user)).json();
          expect(first.answer).toEqual("Twenty five days.");
          expect(create).toHaveBeenCalledTimes(1);

          const second = await (await ask(user)).json();
          expect(second.answer).toBeNull();
          expect(second.documents).toHaveLength(1);
          expect(create).toHaveBeenCalledTimes(1);
        } finally {
          spy.mockRestore();
          await Redis.defaultClient.del(`ai-answers:unmetered:${user.teamId}`);
        }
      });

      it("records no_answer when the model returns nothing", async () => {
        const { user } = await setup();
        create.mockResolvedValue({
          stop_reason: "end_turn",
          usage: { input_tokens: 500, output_tokens: 5 },
          content: [],
        });
        const body = await (await ask(user)).json();
        expect(body.answer).toBeNull();
        const [row] = await AIAnswerUsage.findAll({
          where: { teamId: user.teamId },
        });
        expect(row.outcome).toEqual("no_answer");
        expect(row.inputTokens).toEqual(500);
      });
    });
  });
});
