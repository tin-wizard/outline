import { http, HttpResponse } from "msw";
import { Transaction } from "sequelize";
import { vi } from "vitest";
import { TeamPreference } from "@shared/types";
import { AIAnswerUsage, Team, type User } from "@server/models";
import {
  buildAdmin,
  buildCollection,
  buildDocument,
  buildGuestUser,
  buildUser,
  buildViewer,
} from "@server/test/factories";
import { server as mswServer } from "@server/test/msw";
import { getTestServer } from "@server/test/support";
import { sequelize } from "@server/storage/database";
import Redis from "@server/storage/redis";
import { requestContext } from "@server/storage/requestContext";
import { createConversation } from "../conversation";
import env from "../env";
import { acquireSlot, releaseSlot } from "../usage";
import { HEARTBEAT_MS } from "./ask";

const server = getTestServer();
const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const encoder = new TextEncoder();

interface SseEvent {
  event: string;
  data: ReturnType<typeof JSON.parse>;
}

/** Parses a complete SSE body into events and comment lines. */
function parseSse(text: string): { events: SseEvent[]; comments: string[] } {
  const events: SseEvent[] = [];
  const comments: string[] = [];
  for (const chunk of text.split("\n\n")) {
    let event = "";
    let data = "";
    for (const line of chunk.split("\n")) {
      if (line.startsWith(":")) {
        comments.push(line);
      } else if (line.startsWith("event: ")) {
        event = line.slice(7);
      } else if (line.startsWith("data: ")) {
        data = line.slice(6);
      }
    }
    if (event) {
      events.push({ event, data: JSON.parse(data) });
    }
  }
  return { events, comments };
}

interface MockBlock {
  text: string;
  citations?: Array<{ quote: string; source?: number; start?: number }>;
}

/** The raw Anthropic stream events for a sequence of text content blocks. */
function anthropicEvents(
  blocks: MockBlock[],
  options: { stop?: string; final?: boolean } = {}
): object[] {
  const events: object[] = [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 1,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
    },
  ];
  blocks.forEach((block, index) => {
    events.push({
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "", citations: null },
    });
    for (const c of block.citations ?? []) {
      events.push({
        type: "content_block_delta",
        index,
        delta: {
          type: "citations_delta",
          citation: {
            type: "search_result_location",
            cited_text: c.quote,
            source: "/doc/x",
            title: "x",
            search_result_index: c.source ?? 0,
            start_block_index: c.start ?? 0,
            end_block_index: (c.start ?? 0) + 1,
          },
        },
      });
    }
    events.push({
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: block.text },
    });
    events.push({ type: "content_block_stop", index });
  });
  if (options.final !== false) {
    events.push({
      type: "message_delta",
      delta: { stop_reason: options.stop ?? "end_turn", stop_sequence: null },
      usage: {
        output_tokens: 50,
        input_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    });
    events.push({ type: "message_stop" });
  }
  return events;
}

const frame = (event: object) =>
  encoder.encode(
    `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`
  );

/** A finished upstream stream. */
function sseResponse(events: object[]) {
  return new HttpResponse(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(frame(event));
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

/** Captures each request body and answers with `reply(body)`. */
function upstream(reply: (body: object) => object[]) {
  const bodies: object[] = [];
  mswServer.use(
    http.post(ANTHROPIC, async ({ request }) => {
      const body = await request.json();
      bodies.push(body as object);
      return sseResponse(reply(body as object));
    })
  );
  return bodies;
}

/** Sends `first` events, then hangs until the request is aborted. */
function hangingUpstream(first: object[]) {
  const state = { started: false, aborted: false };
  mswServer.use(
    http.post(ANTHROPIC, ({ request }) => {
      state.started = true;
      return new HttpResponse(
        new ReadableStream({
          start(controller) {
            for (const event of first) {
              controller.enqueue(frame(event));
            }
            request.signal.addEventListener("abort", () => {
              state.aborted = true;
              controller.error(new Error("aborted"));
            });
          },
          cancel() {
            state.aborted = true;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } }
      );
    })
  );
  return state;
}

const waitFor = async (condition: () => boolean, ms = 5000) => {
  for (let i = 0; i < ms / 50 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

async function rowsFor(teamId: string, wait = false) {
  let rows: AIAnswerUsage[] = [];
  for (let i = 0; i < (wait ? 100 : 1); i++) {
    rows = await AIAnswerUsage.findAll({ where: { teamId } });
    if (rows.length > 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return rows;
}

async function expectSlotsFree(teamId: string) {
  const tokens: Array<string | null> = [];
  for (let i = 0; i < 3; i++) {
    tokens.push(await acquireSlot(teamId));
  }
  expect(tokens.every(Boolean)).toEqual(true);
  for (const token of tokens) {
    if (token) {
      await releaseSlot(teamId, token);
    }
  }
}

async function enable(user: User) {
  const team = await Team.findByPk(user.teamId, { rejectOnEmpty: true });
  team.setPreference(TeamPreference.AIAnswers, true);
  await team.save();
  return user;
}

const FACT = "Employees receive twenty five days of holiday.";

async function setup() {
  const user = await enable(await buildUser());
  const collection = await buildCollection({
    teamId: user.teamId,
    userId: user.id,
    name: "People",
  });
  const document = await buildDocument({
    teamId: user.teamId,
    userId: user.id,
    collectionId: collection.id,
    title: "Holidays",
    text: `# Leave\n${FACT}`,
  });
  return { user, collection, document };
}

const ask = (
  user: User,
  body: Record<string, unknown> = { query: "How many days of holiday?" },
  options: Record<string, unknown> = {}
) => server.post("/api/ai.ask", user, { body, ...options });

async function askEvents(user: User, body?: Record<string, unknown>) {
  const res = await ask(user, body);
  expect(res.status).toEqual(200);
  return parseSse(await res.text()).events;
}

const cited = { text: FACT, citations: [{ quote: FACT }] };

describe("#ai.ask", () => {
  it("requires authentication", async () => {
    const res = await server.post("/api/ai.ask", {
      body: { query: "holiday policy" },
    });
    expect(res.status).toEqual(401);
  });

  describe("gates", () => {
    let bodies: object[];
    beforeEach(() => {
      bodies = upstream(() => anthropicEvents([cited]));
    });

    it("returns 403 when the workspace preference is off, without a model call", async () => {
      const user = await buildUser();
      const res = await ask(user);
      expect(res.status).toEqual(403);
      expect(bodies).toHaveLength(0);
    });

    it.each([
      ["guest", buildGuestUser],
      ["viewer", buildViewer],
    ])("denies a %s with 403 and never calls the model", async (_, build) => {
      const user = await enable(await build());
      const res = await ask(user);
      expect(res.status).toEqual(403);
      expect(bodies).toHaveLength(0);
    });

    it("lets an admin through", async () => {
      const admin = await enable(await buildAdmin());
      const res = await ask(admin);
      expect(res.status).toEqual(200);
    });

    it("rejects an oversized query and a malformed conversation id", async () => {
      const { user } = await setup();
      expect((await ask(user, { query: "a".repeat(501) })).status).toEqual(400);
      expect(
        (await ask(user, { query: "holiday", conversationId: "nope" })).status
      ).toEqual(400);
      expect(bodies).toHaveLength(0);
    });
  });

  describe("streaming", () => {
    it("streams conversation, status, sources, blocks and done in order", async () => {
      const { user, document } = await setup();
      const bodies = upstream(() => anthropicEvents([cited]));
      const res = await ask(user);

      expect(res.status).toEqual(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.headers.get("cache-control")).toEqual(
        "no-cache, no-transform"
      );
      expect(res.headers.get("x-accel-buffering")).toEqual("no");
      const { events } = parseSse(await res.text());

      expect(events.map((e) => e.event)).toEqual([
        "conversation",
        "status",
        "sources",
        "status",
        "block",
        "done",
      ]);
      expect(events[1].data).toEqual({ phase: "searching" });
      expect(events[2].data).toEqual([
        {
          n: 1,
          documentId: document.id,
          title: "Holidays",
          url: `/doc/holidays-${document.urlId}`,
          collectionName: "People",
        },
      ]);
      expect(events[3].data).toEqual({ phase: "generating" });
      const block = events[4].data;
      expect(block.index).toEqual(0);
      expect(block.kind).toEqual("paragraph");
      expect(block.markdown).toEqual(FACT);
      expect(block.citations).toEqual([
        {
          n: 1,
          documentId: document.id,
          title: "Holidays",
          url: `/doc/holidays-${document.urlId}#h-leave`,
          quote: FACT,
        },
      ]);
      const done = events[5].data;
      expect(done.conversationId).toEqual(events[0].data.id);
      expect(done.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
      expect(done.timings.totalMs).toBeGreaterThanOrEqual(0);
      expect(done.timings.firstBlockMs).toBeGreaterThanOrEqual(0);

      // The model got the structured prompt and streaming.
      const sent = bodies[0] as { system: string; stream: boolean };
      expect(sent.stream).toEqual(true);
      expect(sent.system).toContain("Markdown");

      const rows = await rowsFor(user.teamId);
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toEqual("answered");
      expect(rows[0].inputTokens).toEqual(100);
      expect(rows[0].outputTokens).toEqual(50);
    });

    it("never compresses the stream", async () => {
      const { user } = await setup();
      upstream(() => anthropicEvents([cited]));
      const res = await ask(user, undefined, {
        headers: { "Accept-Encoding": "gzip, deflate, br" },
        compress: false,
      });
      expect(res.headers.get("content-encoding")).toBeNull();
      const text = await res.text();
      expect(text.startsWith("event: conversation\n")).toEqual(true);
    });

    it("does not emit a block that fails verification", async () => {
      const { user } = await setup();
      upstream(() =>
        anthropicEvents([
          { text: `${FACT}\n\n`, citations: [{ quote: FACT }] },
          { text: "Managers approve every request within two days." },
        ])
      );
      const events = await askEvents(user);
      const blocks = events.filter((e) => e.event === "block");
      expect(blocks).toHaveLength(1);
      expect(blocks[0].data.markdown).toEqual(FACT);
      expect(JSON.stringify(events)).not.toContain("Managers approve");
      expect(events.at(-1)?.event).toEqual("done");
      const rows = await rowsFor(user.teamId);
      expect(rows[0].droppedSegments).toEqual(1);
    });

    it.each([
      ["kept", "| Leave |", true],
      ["dropped", "| See evil.example.com/claim |", false],
    ])(
      "emits table rows only when the header is %s",
      async (_, header, rowsShown) => {
        const { user } = await setup();
        upstream(() =>
          anthropicEvents([
            { text: `${FACT}\n\n`, citations: [{ quote: FACT }] },
            {
              text: `${header}\n| --- |\n| ${FACT} |\n`,
              citations: [{ quote: FACT }],
            },
          ])
        );
        const events = await askEvents(user);
        const kinds = events
          .filter((e) => e.event === "block")
          .map((e) => e.data.kind);
        expect(kinds.includes("tableHeader")).toEqual(rowsShown);
        expect(kinds.includes("tableRow")).toEqual(rowsShown);
        expect(JSON.stringify(events)).not.toContain("evil.example");
      }
    );

    it("reports no_answer without a model call when nothing matches", async () => {
      const user = await enable(await buildUser());
      const bodies = upstream(() => anthropicEvents([cited]));
      const events = await askEvents(user, { query: "zebra quokka" });
      expect(events.map((e) => e.event)).toEqual([
        "conversation",
        "status",
        "sources",
        "failed",
      ]);
      expect(events.at(-1)?.data).toEqual({
        reason: "no_answer",
        partial: false,
      });
      expect(bodies).toHaveLength(0);
    });

    it("fails with partial when generation stops early after blocks were shown", async () => {
      const { user } = await setup();
      upstream(() => anthropicEvents([cited], { stop: "max_tokens" }));
      const events = await askEvents(user);
      expect(events.filter((e) => e.event === "block")).toHaveLength(1);
      expect(events.at(-1)).toEqual({
        event: "failed",
        data: { reason: "error", partial: true },
      });
    });

    it("never writes a heartbeat after the stream has ended, and writes one while it is open", async () => {
      const { user } = await setup();
      const spy = vi.spyOn(globalThis, "setInterval");
      let openGate: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      let arrived = false;
      mswServer.use(
        http.post(ANTHROPIC, async () => {
          arrived = true;
          await gate;
          return sseResponse(anthropicEvents([cited]));
        })
      );
      try {
        const pending = ask(user);
        await waitFor(() => arrived);
        const call = spy.mock.calls.find(([, ms]) => ms === HEARTBEAT_MS);
        expect(call).toBeDefined();
        const handler = call?.[0];
        if (typeof handler === "function") {
          handler();
        }
        openGate();
        const res = await pending;
        const { comments, events } = parseSse(await res.text());
        expect(comments).toContain(": heartbeat");
        expect(events.at(-1)?.event).toEqual("done");
        // After the end: a late tick must not throw or write.
        if (typeof handler === "function") {
          handler();
        }
      } finally {
        openGate();
        spy.mockRestore();
      }
    });
  });

  describe("limits", () => {
    it("over budget fails with budget and never calls the model", async () => {
      const { user } = await setup();
      const bodies = upstream(() => anthropicEvents([cited]));
      await AIAnswerUsage.create({
        teamId: user.teamId,
        userId: null,
        model: "claude-sonnet-5-5",
        inputTokens: 0,
        outputTokens: 0,
        costMicroUsd: String(26_000_000),
        outcome: "answered",
        droppedSegments: 0,
        durationMs: 0,
      });
      const events = await askEvents(user);
      expect(events.at(-1)).toEqual({
        event: "failed",
        data: { reason: "budget", partial: false },
      });
      expect(bodies).toHaveLength(0);
      const rows = await rowsFor(user.teamId);
      expect(rows.map((r) => r.outcome).sort()).toEqual([
        "answered",
        "budget_blocked",
      ]);
    });

    it("an unmetered workspace fails as unavailable and never calls the model", async () => {
      const { user } = await setup();
      const bodies = upstream(() => anthropicEvents([cited]));
      const key = `ai-answers:unmetered:${user.teamId}`;
      await Redis.defaultClient.set(key, "1", "EX", 60);
      try {
        const events = await askEvents(user);
        expect(events.at(-1)?.data).toEqual({
          reason: "unavailable",
          partial: false,
        });
        expect(bodies).toHaveLength(0);
      } finally {
        await Redis.defaultClient.del(key);
      }
    });
  });

  describe("request lifecycle", () => {
    const originalDeadline = env.AI_ANSWERS_DEADLINE_MS;
    afterEach(() => {
      env.AI_ANSWERS_DEADLINE_MS = originalDeadline;
    });

    const firstBlock = () =>
      anthropicEvents([{ text: `${FACT}\n\n`, citations: [{ quote: FACT }] }], {
        final: false,
      });

    it("cancels the upstream call when the client disconnects mid-stream", async () => {
      const { user } = await setup();
      const state = hangingUpstream(firstBlock());
      const controller = new AbortController();
      const res = await ask(user, undefined, { signal: controller.signal });
      let seen = "";
      try {
        for await (const chunk of res.body) {
          seen += chunk.toString();
          if (seen.includes("event: block")) {
            controller.abort();
          }
        }
      } catch {
        // The aborted body rejects; that is the disconnect.
      }
      expect(seen).toContain("event: block");

      await waitFor(() => state.aborted);
      expect(state.aborted).toEqual(true);
      const rows = await rowsFor(user.teamId, true);
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toEqual("error");
      expect(BigInt(rows[0].costMicroUsd) > 0n).toEqual(true);
      await expectSlotsFree(user.teamId);
    });

    it("fails with timeout and partial when the deadline passes mid-stream", async () => {
      const { user } = await setup();
      env.AI_ANSWERS_DEADLINE_MS = 1000;
      const state = hangingUpstream(firstBlock());
      const startedAt = Date.now();
      const events = await askEvents(user);
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(events.filter((e) => e.event === "block")).toHaveLength(1);
      expect(events.at(-1)).toEqual({
        event: "failed",
        data: { reason: "timeout", partial: true },
      });
      await waitFor(() => state.aborted);
      expect(state.aborted).toEqual(true);
      const rows = await rowsFor(user.teamId);
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toEqual("error");
      await expectSlotsFree(user.teamId);
    });

    it("holds no pooled connection during the model call (task 1.2)", async () => {
      const poolMax = sequelize.config.pool?.max ?? 5;
      const users: User[] = [];
      for (let i = 0; i < poolMax; i++) {
        // Stay under the per-workspace cap of three concurrent answers.
        users.push(
          i % 3 === 0
            ? (await setup()).user
            : await buildUser({ teamId: users[users.length - 1].teamId })
        );
      }
      let arrived = 0;
      let openGate: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      mswServer.use(
        http.post(ANTHROPIC, async () => {
          arrived++;
          await gate;
          return sseResponse(anthropicEvents([cited]));
        })
      );
      try {
        const answers = [];
        for (let i = 0; i < poolMax; i++) {
          answers.push(ask(users[i]));
          await waitFor(() => arrived > i);
        }
        expect(arrived).toEqual(poolMax);
        const startedAt = Date.now();
        await sequelize.query("SELECT 1");
        const other = await server.post("/api/auth.info", users[0]);
        expect(other.status).toEqual(200);
        expect(Date.now() - startedAt).toBeLessThan(5000);

        openGate();
        for (const res of await Promise.all(answers)) {
          const { events } = parseSse(await res.text());
          expect(events.at(-1)?.event).toEqual("done");
        }
      } finally {
        openGate();
      }
    }, 60_000);

    it("fails closed when the tenant transaction cannot be released", async () => {
      const { user } = await setup();
      const bodies = upstream(() => anthropicEvents([cited]));
      const commit = Transaction.prototype.commit;
      const spy = vi
        .spyOn(Transaction.prototype, "commit")
        .mockImplementation(async function (this: Transaction) {
          await commit.call(this);
          const store = requestContext.getStore();
          if (store?.tenant && !store.transaction) {
            throw new Error("commit failed");
          }
        });
      try {
        const events = await askEvents(user);
        expect(events.at(-1)?.data).toEqual({
          reason: "unavailable",
          partial: false,
        });
      } finally {
        spy.mockRestore();
      }
      expect(bodies).toHaveLength(0);
      expect(await rowsFor(user.teamId)).toHaveLength(0);
    });
  });

  describe("conversations", () => {
    it("sends a follow-up the original question plus prior turns as quoted data, never the standalone query", async () => {
      const { user } = await setup();
      const bodies = upstream(() => anthropicEvents([cited]));
      const first = await askEvents(user);
      const id = first[0].data.id;

      const second = await askEvents(user, {
        query: "Does that include weekends?",
        conversationId: id,
      });
      expect(second[0]).toEqual({ event: "conversation", data: { id } });
      expect(bodies).toHaveLength(2);
      const content = (
        bodies[1] as {
          messages: Array<{ content: Array<{ type: string; text?: string }> }>;
        }
      ).messages[0].content;
      const texts = content.filter((c) => c.type === "text");
      expect(texts.at(-1)?.text).toEqual("Does that include weekends?");
      const prior = texts[0].text ?? "";
      expect(prior).toContain(
        "<prior_question>How many days of holiday?</prior_question>"
      );
      expect(prior).toContain(`<prior_answer>${FACT}</prior_answer>`);
      // The standalone query appends the earlier question and cited titles.
      const sent = JSON.stringify(bodies[1]);
      expect(sent).not.toContain(
        "Does that include weekends? How many days of holiday?"
      );
    });

    it("drops a prior answer whose document was deleted between turns", async () => {
      const { user, collection, document } = await setup();
      await buildDocument({
        teamId: user.teamId,
        userId: user.id,
        collectionId: collection.id,
        title: "Carry over",
        text: "# Carry over\nUnused holiday carries over until March.",
      });
      const bodies = upstream(() => anthropicEvents([cited]));
      const first = await askEvents(user);
      const id = first[0].data.id;
      await document.destroy();

      await askEvents(user, {
        query: "Does unused holiday carry over?",
        conversationId: id,
      });
      expect(bodies).toHaveLength(2);
      const sent = JSON.stringify(bodies[1]);
      expect(sent).toContain("<prior_question>");
      expect(sent).not.toContain("<prior_answer>");
      expect(sent).not.toContain("twenty five");
    });

    it("starts a new conversation for another user's id", async () => {
      const { user } = await setup();
      upstream(() => anthropicEvents([cited]));
      const other = await buildUser({ teamId: user.teamId });
      const foreign = await createConversation(other);
      expect(foreign).not.toBeNull();

      const events = await askEvents(user, {
        query: "How many days of holiday?",
        conversationId: foreign?.id,
      });
      expect(events[0].event).toEqual("conversation");
      expect(events[0].data.id).not.toEqual(foreign?.id);
      expect(events[1].data.phase).toEqual("notice");
      expect(events.at(-1)?.data.conversationId).toEqual(events[0].data.id);
    });
  });

  it("never sends or emits planted secrets from a document or the query", async () => {
    const user = await enable(await buildUser());
    // Synthetic values assembled at runtime so no real-looking secret is committed.
    const docToken = "gh" + "p_" + "Q".repeat(36);
    const docPassword = "Plant" + "ed9pass";
    const queryKey = "sk-ant-" + "api03-" + "Z".repeat(30);
    const titleToken = "gl" + "pat-" + "Wq7".repeat(8);
    await buildDocument({
      teamId: user.teamId,
      userId: user.id,
      title: `Holiday admin ${titleToken}`,
      text: `# Holiday admin\nThe holiday tool uses ${docToken} to sync.\n\npassword: ${docPassword}`,
    });
    const bodies = upstream(() =>
      anthropicEvents([
        {
          text: `The holiday tool uses ${docToken} to sync.`,
          citations: [{ quote: "The holiday tool uses" }],
        },
      ])
    );
    const res = await ask(user, {
      query: `How many days of holiday? My key is ${queryKey}`,
    });
    const text = await res.text();
    expect(bodies).toHaveLength(1);
    const sent = JSON.stringify(bodies[0]);
    expect(sent).toContain("[REDACTED:");
    for (const secret of [docToken, docPassword, queryKey, titleToken]) {
      expect(sent).not.toContain(secret);
      expect(text).not.toContain(secret);
    }
    expect(text.toLowerCase()).not.toContain("wq7wq7wq7");
  });
});
