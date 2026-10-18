import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { Transaction } from "sequelize";
import { vi } from "vitest";
import { TeamPreference } from "@shared/types";
import { ProsemirrorHelper } from "@shared/utils/ProsemirrorHelper";
import Logger from "@server/logging/Logger";
import {
  AIAnswerUsage,
  AIConversation,
  AIConversationTurn,
  Team,
  type User,
} from "@server/models";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
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
import { validate } from "class-validator";
import {
  ASK_DEFAULT_DEADLINE_MS,
  ASK_DEFAULT_IDLE_MS,
  ASK_MAX_DEADLINE_MS,
  ASK_MAX_IDLE_MS,
  ASK_MIN_DEADLINE_MS,
} from "../contract";
import {
  createConversation,
  deleteConversation,
  loadConversation,
} from "../conversation";
import env from "../env";
import * as usage from "../usage";
import { acquireSlot, releaseSlot, SLOT_TTL_MS } from "../usage";
import * as verify from "../verify";
import {
  clampAskDeadline,
  clampAskIdle,
  HEARTBEAT_MS,
  limitResetsAt,
  streamLimits,
} from "./ask";

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

/**
 * Sends `first` events, then hangs; on abort the body ends cleanly instead of
 * erroring, so the SDK stream finishes without throwing.
 */
function closingUpstream(first: object[]) {
  const state = { aborted: false };
  mswServer.use(
    http.post(
      ANTHROPIC,
      ({ request }) =>
        new HttpResponse(
          new ReadableStream({
            start(controller) {
              for (const event of first) {
                controller.enqueue(frame(event));
              }
              request.signal.addEventListener("abort", () => {
                state.aborted = true;
                controller.close();
              });
            },
            cancel() {
              state.aborted = true;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } }
        )
    )
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

/** Waits until all three slots can be taken (the release may trail the last event). */
async function expectSlotsFree(teamId: string) {
  let free = false;
  for (let attempt = 0; attempt < 50 && !free; attempt++) {
    const tokens: Array<string | null> = [];
    for (let i = 0; i < 3; i++) {
      tokens.push(await acquireSlot(teamId));
    }
    free = tokens.every(Boolean);
    for (const token of tokens) {
      if (token) {
        await releaseSlot(teamId, token);
      }
    }
    if (!free) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  expect(free).toEqual(true);
}

/** Records heartbeat timers so a test can check each one is cleared. */
function watchHeartbeat() {
  const set = vi.spyOn(globalThis, "setInterval");
  const clear = vi.spyOn(globalThis, "clearInterval");
  return {
    expectCleared() {
      const handles = set.mock.calls.flatMap(([, ms], i) =>
        ms === HEARTBEAT_MS ? [set.mock.results[i].value] : []
      );
      expect(handles.length).toBeGreaterThan(0);
      for (const handle of handles) {
        expect(clear.mock.calls.some(([h]) => h === handle)).toEqual(true);
      }
    },
    restore() {
      set.mockRestore();
      clear.mockRestore();
    },
  };
}

async function enable(user: User) {
  const team = await Team.findByPk(user.teamId, { rejectOnEmpty: true });
  team.setPreference(TeamPreference.AIAnswers, true);
  // History is off by default; most tests here exercise it on.
  team.setPreference(TeamPreference.AIConversationHistory, true);
  await team.save();
  return user;
}

/** Turns the workspace's AI conversation history off (Redis-only behaviour). */
async function historyOff(user: User) {
  const team = await Team.findByPk(user.teamId, { rejectOnEmpty: true });
  team.setPreference(TeamPreference.AIConversationHistory, false);
  await team.save();
  return user;
}

const turnsOf = (conversationId: string) =>
  AIConversationTurn.findAll({
    where: { conversationId },
    order: [["position", "ASC"]],
  });

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

const nextUtcMonth = (now = new Date()) =>
  new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  ).toISOString();

const nextUtcDay = (now = new Date()) =>
  new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  ).toISOString();

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
    it("anchors a citation to the editor's id for a repeated heading containing a link", async () => {
      const user = await enable(await buildUser());
      const quote = "Linux holiday installs need twenty five days.";
      const document = await buildDocument({
        teamId: user.teamId,
        userId: user.id,
        title: "Holidays",
        text: `# Install\nMac holiday notes here.\n\n## See [docs](https://example.com)\nFirst.\n\n# Install\n${quote}`,
      });
      const expected = ProsemirrorHelper.getAnchors(
        DocumentHelper.toProsemirror(document)
      ).map((a) => a.id);
      expect(expected).toEqual(["h-install", "h-see-docs", "h-install-1"]);
      upstream(() =>
        anthropicEvents([{ text: quote, citations: [{ quote }] }])
      );

      const res = await ask(user);
      const { events } = parseSse(await res.text());

      const block = events.find((e) => e.event === "block");
      expect(block?.data.citations[0].url).toEqual(
        `/doc/holidays-${document.urlId}#${expected[2]}`
      );
    });

    it("streams conversation, status, sources, blocks and done in order", async () => {
      const { user, collection, document } = await setup();
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
          collectionId: document.collectionId,
          collectionName: "People",
          ...(collection.color ? { collectionColor: collection.color } : {}),
          updatedAt: document.updatedAt.toISOString(),
          updatedByName: user.name,
          publishedAt: document.publishedAt?.toISOString(),
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
          heading: "Leave",
          quote: FACT,
        },
      ]);
      const done = events[5].data;
      expect(done.conversationId).toEqual(events[0].data.id);
      expect(done.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
      expect(done.timings.totalMs).toBeGreaterThanOrEqual(0);
      expect(done.timings.firstBlockMs).toBeGreaterThanOrEqual(0);
      expect(done.retrieval).toEqual({ fetched: 1, used: 1 });

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

    it("reports the usage row id in done so the answer can be rated", async () => {
      const { user } = await setup();
      upstream(() => anthropicEvents([cited]));
      const events = await askEvents(user);
      const done = events.at(-1);
      expect(done?.event).toEqual("done");
      const rows = await rowsFor(user.teamId, true);
      expect(rows).toHaveLength(1);
      expect(done?.data.usageId).toEqual(rows[0].id);
    });

    it("reports a null usageId in done when the usage row could not be saved", async () => {
      const { user } = await setup();
      upstream(() => anthropicEvents([cited]));
      const spy = vi
        .spyOn(AIAnswerUsage, "create")
        .mockRejectedValueOnce(new Error("db down"));
      try {
        const events = await askEvents(user);
        expect(events.at(-1)?.event).toEqual("done");
        expect(events.at(-1)?.data.usageId).toBeNull();
      } finally {
        spy.mockRestore();
      }
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
      expect(events.at(-1)?.data.dropped).toEqual(1);
      const rows = await rowsFor(user.teamId);
      expect(rows[0].droppedSegments).toEqual(1);
      const [turn] = await turnsOf(events[0].data.id);
      expect(turn.droppedSegments).toEqual(1);
      const info = await server.post("/api/aiConversations.info", user, {
        body: { id: events[0].data.id },
      });
      expect((await info.json()).data.turns[0].droppedSegments).toEqual(1);
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

    it("reports a refusal as no_answer", async () => {
      const { user } = await setup();
      upstream(() => anthropicEvents([], { stop: "refusal" }));
      const events = await askEvents(user);
      expect(events.at(-1)).toEqual({
        event: "failed",
        data: { reason: "no_answer", partial: false },
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
        data: {
          reason: "budget",
          partial: false,
          detail: { resetsAt: nextUtcMonth() },
        },
      });
      expect(bodies).toHaveLength(0);
      const rows = await rowsFor(user.teamId);
      expect(rows.map((r) => r.outcome).sort()).toEqual([
        "answered",
        "budget_blocked",
      ]);
    });

    it("a user over their daily limit fails with quota and never calls the model", async () => {
      const { user } = await setup();
      const bodies = upstream(() => anthropicEvents([cited]));
      await AIAnswerUsage.create({
        teamId: user.teamId,
        userId: user.id,
        model: "claude-sonnet-5-5",
        inputTokens: 0,
        outputTokens: 0,
        costMicroUsd: String(2_000_000),
        outcome: "answered",
        droppedSegments: 0,
        durationMs: 0,
      });
      const events = await askEvents(user);
      expect(events.at(-1)).toEqual({
        event: "failed",
        data: {
          reason: "quota",
          partial: false,
          detail: { resetsAt: nextUtcDay() },
        },
      });
      expect(bodies).toHaveLength(0);
      const rows = await rowsFor(user.teamId);
      expect(
        rows
          .map((r) => [r.outcome, r.costMicroUsd])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      ).toEqual([
        ["answered", "2000000"],
        ["quota_blocked", "0"],
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
    const original = {
      askDeadline: env.AI_ASK_DEADLINE_MS,
      idle: env.AI_ASK_IDLE_MS,
    };
    afterEach(() => {
      env.AI_ASK_DEADLINE_MS = original.askDeadline;
      env.AI_ASK_IDLE_MS = original.idle;
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
      // Billed for what was streamed, not the 4096-token ceiling: input from
      // message_start, output from the streamed characters / 3.
      expect(rows[0].inputTokens).toEqual(100);
      expect(rows[0].outputTokens).toEqual(Math.ceil(`${FACT}\n\n`.length / 3));
      await expectSlotsFree(user.teamId);
    });

    it("arms its configured total and idle limits", async () => {
      const { user } = await setup();
      env.AI_ASK_DEADLINE_MS = 20_000;
      env.AI_ASK_IDLE_MS = 7_000;
      upstream(() => anthropicEvents([cited]));
      const spy = vi.spyOn(globalThis, "setTimeout");
      try {
        const events = await askEvents(user);
        expect(events.at(-1)?.event).toEqual("done");
        const delays = spy.mock.calls.map(([, ms]) => ms);
        expect(delays).toContain(20_000);
        expect(delays).toContain(7_000);
      } finally {
        spy.mockRestore();
      }
    });

    it("frees the slot before the usage row is written", async () => {
      const { user } = await setup();
      upstream(() => anthropicEvents([cited]));
      const original = usage.record;
      let freeWhileBilling: boolean | undefined;
      const spy = vi
        .spyOn(usage, "record")
        .mockImplementationOnce(async (entry) => {
          // A slow insert must not hold the slot.
          const tokens = [];
          for (let i = 0; i < 3; i++) {
            tokens.push(await acquireSlot(user.teamId));
          }
          freeWhileBilling = tokens.every(Boolean);
          for (const token of tokens) {
            if (token) {
              await releaseSlot(user.teamId, token);
            }
          }
          return original(entry);
        });
      try {
        const events = await askEvents(user);
        expect(events.at(-1)?.event).toEqual("done");
      } finally {
        spy.mockRestore();
      }
      expect(freeWhileBilling).toEqual(true);
      expect(await rowsFor(user.teamId)).toHaveLength(1);
    });

    it("fails with timeout and partial when the provider goes idle mid-stream", async () => {
      const { user } = await setup();
      env.AI_ASK_IDLE_MS = 1000;
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

    describe("when the aborted stream ends without throwing (QA B1)", () => {
      it("reports a stall after message_start as timeout", async () => {
        const { user } = await setup();
        env.AI_ASK_IDLE_MS = 1000;
        const state = closingUpstream(anthropicEvents([], { final: false }));
        const events = await askEvents(user);
        expect(events.at(-1)).toEqual({
          event: "failed",
          data: { reason: "timeout", partial: false },
        });
        expect(state.aborted).toEqual(true);
        const rows = await rowsFor(user.teamId);
        expect(rows).toHaveLength(1);
        expect(rows[0].outcome).toEqual("error");
        expect(rows[0].inputTokens).toEqual(100);
        const [turn] = await turnsOf(events[0].data.id);
        expect(turn.outcome).toEqual("timeout");
        expect(turn.blocks).toEqual([]);
        await expectSlotsFree(user.teamId);
      });

      it("reports the total cap as timeout, partial after a released block", async () => {
        const { user } = await setup();
        env.AI_ASK_IDLE_MS = ASK_MAX_IDLE_MS;
        env.AI_ASK_DEADLINE_MS = ASK_MIN_DEADLINE_MS;
        closingUpstream(firstBlock());
        const events = await askEvents(user);
        expect(events.filter((e) => e.event === "block")).toHaveLength(1);
        expect(events.at(-1)).toEqual({
          event: "failed",
          data: { reason: "timeout", partial: true },
        });
        const rows = await rowsFor(user.teamId);
        expect(rows.map((r) => r.outcome)).toEqual(["error"]);
        expect(rows[0].outputTokens).toEqual(
          Math.ceil(`${FACT}\n\n`.length / 3)
        );
        await expectSlotsFree(user.teamId);
      }, 20_000);

      it("bills and stores nothing more when the client disconnects", async () => {
        const { user } = await setup();
        const state = closingUpstream(firstBlock());
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
        await waitFor(() => state.aborted);
        const rows = await rowsFor(user.teamId, true);
        expect(rows.map((r) => r.outcome)).toEqual(["error"]);
        expect(
          await AIConversationTurn.count({ where: { userId: user.id } })
        ).toEqual(0);
        await expectSlotsFree(user.teamId);
      });
    });

    it("does nothing when the client is gone before the handler runs", async () => {
      const { user } = await setup();
      const bodies = upstream(() => anthropicEvents([cited]));
      const controller = new AbortController();
      // The pinned transaction is opened by auth, right before the handler:
      // disconnect there and let the server see the close first.
      const original = sequelize.transaction.bind(sequelize);
      let finished = false;
      const spy = vi
        .spyOn(sequelize, "transaction")
        .mockImplementationOnce(async () => {
          controller.abort();
          // Let the server see the close before the handler runs.
          await waitFor(
            () => requestContext.getStore()?.req.socket.destroyed === true
          );
          await new Promise((resolve) => setImmediate(resolve));
          const transaction = await original();
          // Auth commits (or rolls back) once the handler has returned.
          for (const method of ["commit", "rollback"] as const) {
            const real = transaction[method].bind(transaction);
            transaction[method] = async () => {
              try {
                await real();
              } finally {
                finished = true;
              }
            };
          }
          return transaction;
        });
      try {
        await ask(user, undefined, { signal: controller.signal }).catch(
          () => undefined
        );
        await waitFor(() => finished);
        expect(finished).toEqual(true);
      } finally {
        spy.mockRestore();
      }
      expect(bodies).toHaveLength(0);
      expect(await rowsFor(user.teamId)).toHaveLength(0);
      expect(
        await Redis.defaultClient.keys(`aiconv:${user.teamId}:${user.id}:*`)
      ).toEqual([]);
      await expectSlotsFree(user.teamId);
    });

    it("frees the slot and never calls the model when the verifier cannot be built", async () => {
      const { user } = await setup();
      const bodies = upstream(() => anthropicEvents([cited]));
      const spy = vi
        .spyOn(verify, "AnswerVerifier")
        .mockImplementation(function () {
          throw new Error("boom");
        });
      try {
        const events = await askEvents(user);
        expect(events.at(-1)).toEqual({
          event: "failed",
          data: { reason: "error", partial: false },
        });
      } finally {
        spy.mockRestore();
      }
      expect(bodies).toHaveLength(0);
      await expectSlotsFree(user.teamId);
    });

    it("records the billed call and frees the slot when verification throws mid-stream", async () => {
      const { user } = await setup();
      upstream(() => anthropicEvents([cited]));
      const spy = vi
        .spyOn(verify.AnswerVerifier.prototype, "verify")
        .mockImplementation(() => {
          throw new Error("boom");
        });
      try {
        const events = await askEvents(user);
        expect(events.at(-1)?.data).toEqual({
          reason: "error",
          partial: false,
        });
      } finally {
        spy.mockRestore();
      }
      const rows = await rowsFor(user.teamId);
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toEqual("error");
      await expectSlotsFree(user.teamId);
    });

    it("still records usage when the final gate throws", async () => {
      const { user } = await setup();
      upstream(() => anthropicEvents([cited]));
      const spy = vi
        .spyOn(verify.AnswerVerifier.prototype, "finish")
        .mockImplementation(() => {
          throw new Error("boom");
        });
      try {
        const events = await askEvents(user);
        expect(events.at(-1)?.data).toEqual({
          reason: "error",
          partial: true,
        });
      } finally {
        spy.mockRestore();
      }
      const rows = await rowsFor(user.teamId);
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toEqual("error");
      expect(rows[0].inputTokens).toEqual(100);
      expect(rows[0].outputTokens).toEqual(50);
      await expectSlotsFree(user.teamId);
    });

    it("clears the heartbeat on done, failed and disconnect", async () => {
      const { user } = await setup();
      const heartbeat = watchHeartbeat();
      try {
        upstream(() => anthropicEvents([cited]));
        await askEvents(user);
        await askEvents(user, { query: "zebra quokka" });
        const state = hangingUpstream(firstBlock());
        const controller = new AbortController();
        const res = await ask(user, undefined, { signal: controller.signal });
        try {
          for await (const chunk of res.body) {
            if (chunk.toString().includes("event: block")) {
              controller.abort();
            }
          }
        } catch {
          // Disconnect.
        }
        await waitFor(() => state.aborted);
        await rowsFor(user.teamId, true);
        await expectSlotsFree(user.teamId);
        heartbeat.expectCleared();
      } finally {
        heartbeat.restore();
      }
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
      // Nothing from a turn whose source is gone: no answer, no question.
      expect(sent).not.toContain("<prior_question>");
      expect(sent).not.toContain("How many days of holiday?");
      expect(sent).not.toContain("<prior_answer>");
      expect(sent).not.toContain("twenty five");
    });

    it("returns a null conversationId when the turn could not be stored", async () => {
      const user = await historyOff((await setup()).user);
      upstream(() => anthropicEvents([cited]));
      const first = await askEvents(user);
      const id = first[0].data.id;
      // The follow-up loads with MULTI; its only SET is the append.
      const spy = vi
        .spyOn(Redis.defaultClient, "set")
        .mockRejectedValueOnce(new Error("redis down"));
      try {
        const events = await askEvents(user, {
          query: "How many days of holiday?",
          conversationId: id,
        });
        expect(events[0]).toEqual({ event: "conversation", data: { id } });
        expect(events.at(-1)?.event).toEqual("done");
        expect(events.at(-1)?.data.conversationId).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });

    it("answers without history when Redis is down for the whole turn", async () => {
      const user = await historyOff((await setup()).user);
      upstream(() => anthropicEvents([cited]));
      const set = vi
        .spyOn(Redis.defaultClient, "set")
        .mockRejectedValue(new Error("redis down"));
      const multi = vi
        .spyOn(Redis.defaultClient, "multi")
        .mockImplementation(() => {
          throw new Error("redis down");
        });
      try {
        const events = await askEvents(user, {
          query: "How many days of holiday?",
          conversationId: "6f1c1c55-7a4e-4a43-9a8e-0d6b8f5f2c11",
        });
        expect(events.some((e) => e.event === "conversation")).toEqual(false);
        expect(events[0].event).toEqual("status");
        expect(events[0].data.phase).toEqual("notice");
        expect(events[0].data.notice).toEqual("history_unavailable");
        expect(events.at(-1)?.event).toEqual("done");
        expect(events.at(-1)?.data.conversationId).toBeNull();
      } finally {
        set.mockRestore();
        multi.mockRestore();
      }
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
      expect(events[1].data.notice).toEqual("conversation_new");
      expect(events.at(-1)?.data.conversationId).toEqual(events[0].data.id);
    });
  });

  describe("stored history", () => {
    // Synthetic, assembled at runtime so the repository holds no credential-like literal.
    const planted = "sk-ant-" + "api03-" + "b".repeat(30);

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("stores the verified blocks, anchored citations and the redacted question on done", async () => {
      const { user, document } = await setup();
      upstream(() => anthropicEvents([cited]));
      const events = await askEvents(user, {
        query: `How many days of holiday? ${planted}`,
      });
      const id = events[0].data.id;
      const done = events.at(-1);
      expect(done?.event).toEqual("done");
      expect(done?.data.conversationId).toEqual(id);

      const conversation = await AIConversation.findByPk(id, {
        rejectOnEmpty: true,
      });
      expect(conversation.userId).toEqual(user.id);
      expect(conversation.teamId).toEqual(user.teamId);
      expect(conversation.title).not.toContain(planted);
      const [turn, ...rest] = await turnsOf(id);
      expect(rest).toHaveLength(0);
      expect(turn.question).not.toContain(planted);
      expect(turn.question.startsWith("How many days of holiday?")).toBe(true);
      expect(turn.outcome).toEqual("answered");
      expect(turn.usageId).toEqual(done?.data.usageId);
      expect(turn.citedDocumentIds).toEqual([document.id]);
      expect(turn.blocks).toEqual([
        {
          kind: "paragraph",
          markdown: FACT,
          citations: [
            {
              documentId: document.id,
              quote: FACT,
              heading: "Leave",
              anchor: "h-leave",
            },
          ],
        },
      ]);

      // Reopening the chat links to the same section as the live answer.
      const block = events.find((e) => e.event === "block");
      const info = await server.post("/api/aiConversations.info", user, {
        body: { id },
      });
      const { data } = await info.json();
      expect(data.turns[0].blocks[0].citations[0].url).toEqual(
        block?.data.citations[0].url
      );
      expect(block?.data.citations[0].url).toContain("#h-leave");
      expect(block?.data.citations[0].heading).toEqual("Leave");
      expect(data.turns[0].blocks[0].citations[0].heading).toEqual("Leave");
      expect(done?.data.dropped).toEqual(0);
      expect(data.turns[0].droppedSegments).toEqual(0);
    });

    it("applies the stored path's anchor and heading rules to the live stream", async () => {
      const { user } = await setup();
      upstream(() => anthropicEvents([cited]));
      const original = verify.AnswerVerifier.prototype.verify;
      vi.spyOn(verify.AnswerVerifier.prototype, "verify").mockImplementation(
        function (this: verify.AnswerVerifier, block) {
          const verdict = original.call(this, block);
          return verdict.ok
            ? {
                ...verdict,
                citations: verdict.citations.map((c) => ({
                  ...c,
                  anchor: 'h-x"><img src=x>',
                  headingText: "Keys AKIAIOSFODNN7EXAMPLE",
                })),
              }
            : verdict;
        }
      );
      const events = await askEvents(user);
      const block = events.find((e) => e.event === "block");
      expect(block?.data.citations[0].url).not.toContain("#");
      expect(block?.data.citations[0].heading).toBeUndefined();
      // The stored path uses the same helper (history.test.ts, anchors.test.ts).
    });

    it("stores only the question when the answer fails, never partial blocks", async () => {
      const { user } = await setup();
      upstream(() => anthropicEvents([cited], { stop: "max_tokens" }));
      const events = await askEvents(user);
      expect(events.filter((e) => e.event === "block")).toHaveLength(1);
      expect(events.at(-1)?.event).toEqual("failed");
      const [turn] = await turnsOf(events[0].data.id);
      expect(turn.question).toEqual("How many days of holiday?");
      expect(turn.outcome).toEqual("error");
      expect(turn.blocks).toEqual([]);
      expect(turn.citedDocumentIds).toEqual([]);
    });

    it("stores the question of a turn that found no sources, after releasing the request transaction", async () => {
      const user = await enable(await buildUser());
      const held: boolean[] = [];
      const create = AIConversationTurn.create.bind(AIConversationTurn);
      vi.spyOn(AIConversationTurn, "create").mockImplementation(
        async (...args) => {
          held.push(!!requestContext.getStore()?.transaction);
          return create(...args);
        }
      );
      const events = await askEvents(user, { query: "zebra quokka" });
      expect(held).toEqual([false]);
      expect(events.at(-1)?.data.reason).toEqual("no_answer");
      const [turn] = await turnsOf(events[0].data.id);
      expect(turn.question).toEqual("zebra quokka");
      expect(turn.outcome).toEqual("no_answer");
    });

    it("stores nothing when the client disconnects", async () => {
      const { user } = await setup();
      hangingUpstream(
        anthropicEvents(
          [{ text: `${FACT}\n\n`, citations: [{ quote: FACT }] }],
          {
            final: false,
          }
        )
      );
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
      await rowsFor(user.teamId, true);
      await expectSlotsFree(user.teamId);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(
        await AIConversationTurn.count({ where: { userId: user.id } })
      ).toEqual(0);
      expect(
        await AIConversation.count({ where: { userId: user.id } })
      ).toEqual(0);
    });

    it("stores a follow-up to a stopped first answer under the same id", async () => {
      const { user } = await setup();
      hangingUpstream(
        anthropicEvents(
          [{ text: `${FACT}\n\n`, citations: [{ quote: FACT }] }],
          { final: false }
        )
      );
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
      const id = parseSse(seen).events[0].data.id;
      await rowsFor(user.teamId, true);
      await expectSlotsFree(user.teamId);
      expect(await AIConversation.findByPk(id)).toBeNull();

      upstream(() => anthropicEvents([cited]));
      const next = await askEvents(user, {
        query: "How many holiday days do I get?",
        conversationId: id,
      });
      expect(next[0]).toEqual({ event: "conversation", data: { id } });
      expect(next.at(-1)?.data.conversationId).toEqual(id);
      const info = await server.post("/api/aiConversations.info", user, {
        body: { id },
      });
      expect(info.status).toEqual(200);
      const { data } = await info.json();
      expect(data.title).toEqual("How many holiday days do I get?");
      expect(
        data.turns.map((t: { position: number; question: string }) => [
          t.position,
          t.question,
        ])
      ).toEqual([[0, "How many holiday days do I get?"]]);
    });

    it("titles a conversation stored late from its first question in the hot cache", async () => {
      const user = await historyOff((await setup()).user);
      upstream(() => anthropicEvents([cited]));
      const id = (await askEvents(user))[0].data.id;
      await enable(user);
      const team = await Team.findByPk(user.teamId, { rejectOnEmpty: true });
      team.setPreference(TeamPreference.AIConversationHistory, true);
      await team.save();

      const next = await askEvents(user, {
        query: "Does that include weekends?",
        conversationId: id,
      });
      expect(next.at(-1)?.data.conversationId).toEqual(id);
      const conversation = await AIConversation.findByPk(id, {
        rejectOnEmpty: true,
      });
      expect(conversation.title).toEqual("How many days of holiday?");
      expect((await turnsOf(id)).map((t) => t.position)).toEqual([0]);
    });

    it("never recreates a conversation deleted while a turn was streaming", async () => {
      const { user } = await setup();
      upstream(() => anthropicEvents([cited]));
      const id = (await askEvents(user))[0].data.id;

      let arrived = false;
      let openGate: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      mswServer.use(
        http.post(ANTHROPIC, async () => {
          arrived = true;
          await gate;
          return sseResponse(anthropicEvents([cited]));
        })
      );
      const pending = ask(user, {
        query: "Does that include weekends?",
        conversationId: id,
      });
      await waitFor(() => arrived);
      const deleted = await server.post("/api/aiConversations.delete", user, {
        body: { id },
      });
      expect(deleted.status).toEqual(200);
      openGate();
      const events = parseSse(await (await pending).text()).events;
      expect(events.at(-1)?.event).toEqual("done");
      expect(events.at(-1)?.data.conversationId).toBeNull();
      expect(await AIConversation.findByPk(id)).toBeNull();
      expect(await turnsOf(id)).toHaveLength(0);

      // Asking again with the deleted id starts over under a new id.
      upstream(() => anthropicEvents([cited]));
      const again = await askEvents(user, {
        query: "Again?",
        conversationId: id,
      });
      expect(again[0].data.id).not.toEqual(id);
      expect(again[1].data.notice).toEqual("conversation_new");
      expect(await AIConversation.findByPk(id)).toBeNull();
    });

    it("stores nothing in the database when history is off", async () => {
      const user = await historyOff((await setup()).user);
      upstream(() => anthropicEvents([cited]));
      const events = await askEvents(user);
      const id = events[0].data.id;
      expect(events.at(-1)?.data.conversationId).toEqual(id);
      expect(await AIConversation.findByPk(id)).toBeNull();

      // Without stored history an expired conversation starts over, as before.
      await deleteConversation(user, id);
      const again = await askEvents(user, {
        query: "Again?",
        conversationId: id,
      });
      expect(again[0].data.id).not.toEqual(id);
      expect(again[1].data.notice).toEqual("conversation_new");
    });

    it("keeps answering when storing fails, reporting the id that was stored", async () => {
      const { user } = await setup();
      upstream(() => anthropicEvents([cited]));
      const warn = vi.spyOn(Logger, "warn");
      vi.spyOn(AIConversationTurn, "create").mockRejectedValue(
        new Error("db down")
      );
      const events = await askEvents(user);
      const id = events[0].data.id;
      // Redis still holds the turn.
      expect(events.at(-1)?.event).toEqual("done");
      expect(events.at(-1)?.data.conversationId).toEqual(id);
      expect(await AIConversation.findByPk(id)).toBeNull();

      // Neither store: null.
      vi.spyOn(Redis.defaultClient, "set").mockRejectedValue(
        new Error("redis down")
      );
      const next = await askEvents(user, {
        query: "Holiday allowance?",
        conversationId: id,
      });
      expect(next.at(-1)?.event).toEqual("done");
      expect(next.at(-1)?.data.conversationId).toBeNull();
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain("holiday");
      expect(logged).not.toContain("Holiday");
      expect(logged).not.toContain(FACT);
    });

    it("stores turns under a new id when Redis is down", async () => {
      const { user } = await setup();
      upstream(() => anthropicEvents([cited]));
      vi.spyOn(Redis.defaultClient, "set").mockRejectedValue(
        new Error("redis down")
      );
      vi.spyOn(Redis.defaultClient, "multi").mockImplementation(() => {
        throw new Error("redis down");
      });
      const events = await askEvents(user);
      expect(events[0].event).toEqual("conversation");
      const id = events[0].data.id;
      expect(events.at(-1)?.data.conversationId).toEqual(id);
      expect(await turnsOf(id)).toHaveLength(1);

      // Resumed from the database alone, with its context.
      const bodies = upstream(() => anthropicEvents([cited]));
      const next = await askEvents(user, {
        query: "Does that include weekends?",
        conversationId: id,
      });
      expect(next[0]).toEqual({ event: "conversation", data: { id } });
      expect(next.some((e) => e.data?.phase === "notice")).toEqual(false);
      expect(JSON.stringify(bodies[0])).toContain(
        `<prior_answer>${FACT}</prior_answer>`
      );
      expect((await turnsOf(id)).map((t) => t.position)).toEqual([0, 1]);
    });

    it("continues a stored conversation with its context after the hot cache expired", async () => {
      const { user } = await setup();
      const bodies = upstream(() => anthropicEvents([cited]));
      const first = await askEvents(user);
      const id = first[0].data.id;
      expect(await deleteConversation(user, id)).toEqual(true);

      const second = await askEvents(user, {
        query: "Does that include weekends?",
        conversationId: id,
      });
      expect(second[0]).toEqual({ event: "conversation", data: { id } });
      expect(second.some((e) => e.data?.notice === "conversation_new")).toEqual(
        false
      );
      expect(second.at(-1)?.data.conversationId).toEqual(id);
      expect(bodies).toHaveLength(2);
      const sent = JSON.stringify(bodies[1]);
      expect(sent).toContain(
        "<prior_question>How many days of holiday?</prior_question>"
      );
      expect(sent).toContain(`<prior_answer>${FACT}</prior_answer>`);
      expect((await turnsOf(id)).map((t) => t.position)).toEqual([0, 1]);
      // The hot cache was rebuilt and holds both turns again.
      expect(
        (await loadConversation(user, id)).conversation?.turns.map(
          (t) => t.question
        )
      ).toEqual(["How many days of holiday?", "Does that include weekends?"]);
    });

    it("hides a revoked source's answer from the model when resuming", async () => {
      const { user, collection, document } = await setup();
      await buildDocument({
        teamId: user.teamId,
        userId: user.id,
        collectionId: collection.id,
        title: "Carry over",
        text: "# Carry over\nUnused holiday carries over until March.",
      });
      const bodies = upstream(() => anthropicEvents([cited]));
      const id = (await askEvents(user))[0].data.id;
      await deleteConversation(user, id);
      await document.destroy();

      await askEvents(user, {
        query: "Does unused holiday carry over?",
        conversationId: id,
      });
      expect(bodies).toHaveLength(2);
      const sent = JSON.stringify(bodies[1]);
      expect(sent).not.toContain("<prior_question>");
      expect(sent).not.toContain("How many days of holiday?");
      expect(sent).not.toContain("<prior_answer>");
      expect(sent).not.toContain("twenty five");
      // The owner still sees their own question.
      const info = await server.post("/api/aiConversations.info", user, {
        body: { id },
      });
      expect((await info.json()).data.turns[0].question).toEqual(
        "How many days of holiday?"
      );
    });

    it("stores nothing when only AI answers is on (history defaults to off)", async () => {
      const user = await buildUser();
      const team = await Team.findByPk(user.teamId, { rejectOnEmpty: true });
      team.setPreference(TeamPreference.AIAnswers, true);
      await team.save();
      const collection = await buildCollection({
        teamId: user.teamId,
        userId: user.id,
      });
      await buildDocument({
        teamId: user.teamId,
        userId: user.id,
        collectionId: collection.id,
        title: "Holidays",
        text: `# Leave\n${FACT}`,
      });
      upstream(() => anthropicEvents([cited]));
      const events = await askEvents(user);
      expect(events.at(-1)?.data.conversationId).toEqual(events[0].data.id);
      expect(await AIConversation.findByPk(events[0].data.id)).toBeNull();
    });

    it("starts a new conversation for another user's stored conversation", async () => {
      const { user } = await setup();
      upstream(() => anthropicEvents([cited]));
      const other = await buildUser({ teamId: user.teamId });
      const foreign = (await askEvents(other))[0].data.id;

      const events = await askEvents(user, {
        conversationId: foreign,
        query: "How many days of holiday?",
      });
      expect(events[0].data.id).not.toEqual(foreign);
      expect(events[1].data.notice).toEqual("conversation_new");
      expect(events.at(-1)?.data.conversationId).toEqual(events[0].data.id);
      expect(await turnsOf(foreign)).toHaveLength(1);
      expect(await turnsOf(events[0].data.id)).toHaveLength(1);
    });

    it("reads no tenant data after the request transaction is released", async () => {
      const { user } = await setup();
      let modelCalled = false;
      upstream(() => {
        modelCalled = true;
        return anthropicEvents([cited]);
      });
      const statements: string[] = [];
      const query = sequelize.query.bind(sequelize);
      vi.spyOn(sequelize, "query").mockImplementation(((
        sql: Parameters<typeof sequelize.query>[0],
        options?: Parameters<typeof sequelize.query>[1]
      ) => {
        if (modelCalled) {
          statements.push(typeof sql === "string" ? sql : sql.query);
        }
        return query(sql, options);
      }) as typeof sequelize.query);
      const events = await askEvents(user);
      expect(events.at(-1)?.event).toEqual("done");
      expect(statements.join("\n")).toContain("ai_conversation_turns");
      for (const statement of statements) {
        expect(statement).not.toMatch(
          /"(documents|collections|users|teams|user_memberships|group_memberships|group_users|groups|shares)"/
        );
      }
    });
  });

  describe("scope", () => {
    it("rejects too many scope ids, bad dates and an inverted range with 400, without a model call", async () => {
      const { user } = await setup();
      const bodies = upstream(() => anthropicEvents([cited]));
      const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
      for (const extra of [
        { collectionIds: ids(11) },
        { collectionIds: ids(10), collectionId: randomUUID() },
        { documentIds: ids(21) },
        { documentIds: ids(20), documentId: randomUUID() },
        { collectionIds: ["nope"] },
        { dateFrom: "2026-13-01" },
        { dateFrom: "yesterday" },
        { dateFrom: "2026-10-02", dateTo: "2026-10-01" },
      ]) {
        const res = await ask(user, { query: "holiday", ...extra });
        expect(res.status).toEqual(400);
      }
      expect(bodies).toHaveLength(0);
    });

    it("answers within several collections and documents", async () => {
      const { user, collection, document } = await setup();
      const other = await buildCollection({
        teamId: user.teamId,
        userId: user.id,
      });
      upstream(() => anthropicEvents([cited]));
      const events = await askEvents(user, {
        query: "How many days of holiday?",
        collectionIds: [collection.id, other.id],
        documentIds: [document.id],
        dateFrom: "2000-01-01",
      });
      expect(events.at(-1)?.event).toEqual("done");
      const sources = events.find((e) => e.event === "sources");
      expect(
        sources?.data.map((s: { documentId: string }) => s.documentId)
      ).toEqual([document.id]);
    });

    it.each([
      ["an unreadable collection", "collectionIds"],
      ["an unreadable document", "documentIds"],
      ["another workspace's collection", "collectionIds"],
      ["an unknown document", "documentIds"],
    ])(
      "fails with scope_forbidden for %s, naming nothing and storing nothing",
      async (label, field) => {
        const { user, collection } = await setup();
        const bodies = upstream(() => anthropicEvents([cited]));
        const owner = await buildUser({ teamId: user.teamId });
        const secret = await buildCollection({
          teamId: user.teamId,
          userId: owner.id,
          permission: null,
          name: "Board Minutes",
        });
        const hidden = await buildDocument({
          teamId: user.teamId,
          userId: owner.id,
          collectionId: secret.id,
          title: "Salaries",
        });
        const foreign = await buildCollection({ name: "Elsewhere" });
        const id = label.startsWith("an unreadable collection")
          ? secret.id
          : label.startsWith("an unreadable document")
            ? hidden.id
            : label.startsWith("another")
              ? foreign.id
              : randomUUID();
        const res = await ask(user, {
          query: "How many days of holiday?",
          ...(field === "collectionIds"
            ? { collectionIds: [collection.id, id] }
            : { documentIds: [id] }),
        });
        expect(res.status).toEqual(200);
        const text = await res.text();
        const { events } = parseSse(text);
        expect(events.at(-1)).toEqual({
          event: "failed",
          data: { reason: "scope_forbidden", partial: false },
        });
        expect(events.some((e) => e.event === "sources")).toBe(false);
        for (const name of ["Board Minutes", "Salaries", "Elsewhere", id]) {
          expect(text).not.toContain(name);
        }
        expect(bodies).toHaveLength(0);
        expect(await rowsFor(user.teamId)).toHaveLength(0);
        expect(
          await AIConversationTurn.count({ where: { userId: user.id } })
        ).toEqual(0);
      }
    );

    it("stores the scope, timings and retrieval counts with the turn", async () => {
      const { user, collection, document } = await setup();
      upstream(() => anthropicEvents([cited]));
      const events = await askEvents(user, {
        query: "How many days of holiday?",
        collectionId: collection.id,
        documentIds: [document.id, document.id],
        dateFrom: "2000-01-01",
        dateTo: "2999-12-31",
      });
      const done = events.at(-1);
      expect(done?.event).toEqual("done");
      const [turn] = await turnsOf(events[0].data.id);
      expect(turn.scope).toEqual({
        collectionIds: [collection.id],
        documentIds: [document.id],
        dateFrom: "2000-01-01",
        dateTo: "2999-12-31",
      });
      expect(turn.totalMs).toEqual(done?.data.timings.totalMs);
      expect(turn.firstBlockMs).toEqual(done?.data.timings.firstBlockMs);
      expect(turn.retrievalFetched).toEqual(1);
      expect(turn.retrievalUsed).toEqual(1);
    });

    it("stores no scope or timings for an unscoped turn that found nothing", async () => {
      const { user } = await setup();
      upstream(() => anthropicEvents([cited]));
      const events = await askEvents(user, { query: "zebra migration" });
      expect(events.at(-1)?.data.reason).toEqual("no_answer");
      const [turn] = await turnsOf(events[0].data.id);
      expect(turn.scope).toBeNull();
      expect(turn.totalMs).toBeNull();
      expect(turn.retrievalFetched).toEqual(0);
      expect(turn.retrievalUsed).toEqual(0);
    });
  });

  describe("compare", () => {
    const BASIC = "The Basic plan costs 10 EUR per month.";
    const PRO = "The Pro plan costs 30 EUR per month.";
    const QUERY = "Compare the plan pricing";

    async function compareOn(user: User) {
      const team = await Team.findByPk(user.teamId, { rejectOnEmpty: true });
      team.setPreference(TeamPreference.AICompare, true);
      await team.save();
      return user;
    }

    async function plans(count = 2) {
      const user = await compareOn(await enable(await buildUser()));
      const docs = [
        ["Basic Plan", `# Pricing\n${BASIC}`],
        ["Pro Plan", `# Pricing\n${PRO}`],
      ].slice(0, count);
      for (const [title, text] of docs) {
        await buildDocument({
          teamId: user.teamId,
          userId: user.id,
          title,
          text,
        });
      }
      return user;
    }

    /** The index of the sent search result with this title. */
    const indexOf = (body: object, title: string) =>
      (
        body as { messages: { content: { type: string; title?: string }[] }[] }
      ).messages[0].content
        .filter((c) => c.type === "search_result")
        .findIndex((c) => c.title === title);

    const comparison = (body: object) =>
      anthropicEvents([
        { text: "| Aspect | Basic Plan | Pro Plan |\n| --- | --- | --- |\n" },
        {
          text: "| Pricing | 10 EUR per month | 30 EUR per month |\n",
          citations: [
            { quote: BASIC, source: indexOf(body, "Basic Plan") },
            { quote: PRO, source: indexOf(body, "Pro Plan") },
          ],
        },
        { text: "\nThe Pro plan is the better choice.\n" },
        { text: "\nThe documents do not cover discounts." },
      ]);

    it("is off by default and rejected with compare_disabled, without a model call", async () => {
      const { user } = await setup();
      const bodies = upstream(() => anthropicEvents([cited]));
      const res = await ask(user, { query: QUERY, mode: "compare" });
      expect(res.status).toEqual(403);
      expect((await res.json()).error).toEqual("compare_disabled");
      expect(bodies).toHaveLength(0);
    });

    it("rejects an unknown mode with 400", async () => {
      const { user } = await setup();
      expect(
        (await ask(user, { query: QUERY, mode: "summary" })).status
      ).toEqual(400);
    });

    it("streams a verified comparison table with per-source citations and done.mode", async () => {
      const user = await plans();
      const bodies = upstream(comparison);
      const events = await askEvents(user, { query: QUERY, mode: "compare" });
      expect((bodies[0] as { system: string }).system).toContain("Aspect");
      const blocks = events.filter((e) => e.event === "block");
      expect(blocks.map((b) => b.data.kind)).toEqual([
        "tableHeader",
        "tableRow",
        "paragraph",
      ]);
      expect(
        blocks[1].data.citations.map((c: { title: string }) => c.title)
      ).toEqual(["Basic Plan", "Pro Plan"]);
      expect(blocks[2].data.markdown).toEqual(
        "The documents do not cover discounts."
      );
      const done = events.at(-1);
      expect(done?.event).toEqual("done");
      expect(done?.data.mode).toEqual("compare");
      expect(done?.data.dropped).toEqual(1);
      const [turn] = await turnsOf(events[0].data.id);
      expect(turn.scope).toEqual({
        collectionIds: [],
        documentIds: [],
        mode: "compare",
      });
    });

    it("fails with compare_needs_two and no model call when fewer than two documents are found", async () => {
      const user = await plans(1);
      const bodies = upstream(comparison);
      const events = await askEvents(user, { query: QUERY, mode: "compare" });
      expect(events.at(-1)).toEqual({
        event: "failed",
        data: { reason: "compare_needs_two", partial: false },
      });
      expect(bodies).toHaveLength(0);
      expect(await rowsFor(user.teamId)).toHaveLength(0);
    });

    it("keeps the budget gate in compare mode", async () => {
      const user = await plans();
      const bodies = upstream(comparison);
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
      const events = await askEvents(user, { query: QUERY, mode: "compare" });
      expect(events.at(-1)?.data.reason).toEqual("budget");
      expect(bodies).toHaveLength(0);
    });

    it("answers in answer mode by default, with the answer prompt and done.mode", async () => {
      const user = await plans();
      const bodies = upstream((body) =>
        anthropicEvents([
          {
            text: BASIC,
            citations: [{ quote: BASIC, source: indexOf(body, "Basic Plan") }],
          },
        ])
      );
      const events = await askEvents(user, { query: QUERY });
      expect((bodies[0] as { system: string }).system).not.toContain(
        "| Aspect |"
      );
      expect(events.at(-1)?.data.mode).toEqual("answer");
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

describe("limitResetsAt", () => {
  it("resets the budget at the next UTC month and the quota at the next UTC day", () => {
    const late = new Date("2026-12-31T23:30:00-05:00"); // 2027-01-01T04:30Z
    expect(limitResetsAt("budget", late)).toEqual("2027-02-01T00:00:00.000Z");
    expect(limitResetsAt("quota", late)).toEqual("2027-01-02T00:00:00.000Z");
    const dec = new Date("2026-12-31T12:00:00Z");
    expect(limitResetsAt("budget", dec)).toEqual("2027-01-01T00:00:00.000Z");
    expect(limitResetsAt("quota", dec)).toEqual("2027-01-01T00:00:00.000Z");
  });
});

describe("ai.ask limits", () => {
  it("keeps the longest total cap below the slot lifetime", () => {
    expect(SLOT_TTL_MS).toBeGreaterThan(ASK_MAX_DEADLINE_MS);
  });

  it.each([
    [-5, 10_000],
    [NaN, ASK_DEFAULT_DEADLINE_MS],
    [999_999, 50_000],
    [20_000, 20_000],
  ])("clamps a total cap of %s to %s", (value, expected) => {
    expect(clampAskDeadline(value)).toEqual(expected);
  });

  it.each([
    [-5, 1_000],
    [NaN, ASK_DEFAULT_IDLE_MS],
    [999_999, 30_000],
  ])("clamps an idle limit of %s to %s", (value, expected) => {
    expect(clampAskIdle(value)).toEqual(expected);
  });

  it("never fails environment validation for odd values", async () => {
    const original = [env.AI_ASK_DEADLINE_MS, env.AI_ASK_IDLE_MS];
    env.AI_ASK_DEADLINE_MS = -1;
    env.AI_ASK_IDLE_MS = NaN;
    try {
      expect(await validate(env)).toEqual([]);
    } finally {
      [env.AI_ASK_DEADLINE_MS, env.AI_ASK_IDLE_MS] = original;
    }
  });

  describe("streamLimits", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("lets a slow stream that keeps producing events run past 15 s", () => {
      const limits = streamLimits(15_000, 45_000);
      for (let s = 0; s < 20; s++) {
        vi.advanceTimersByTime(1_000);
        limits.touch();
      }
      expect(limits.signal.aborted).toEqual(false);
      limits.stop();
    });

    it("aborts after an idle gap", () => {
      const limits = streamLimits(15_000, 45_000);
      vi.advanceTimersByTime(5_000);
      limits.touch();
      vi.advanceTimersByTime(14_999);
      expect(limits.signal.aborted).toEqual(false);
      vi.advanceTimersByTime(1);
      expect(limits.signal.aborted).toEqual(true);
      limits.stop();
    });

    it("aborts at the total cap even while events keep arriving", () => {
      const limits = streamLimits(15_000, 45_000);
      for (let s = 0; s < 44; s++) {
        vi.advanceTimersByTime(1_000);
        limits.touch();
      }
      expect(limits.signal.aborted).toEqual(false);
      vi.advanceTimersByTime(1_000);
      expect(limits.signal.aborted).toEqual(true);
      limits.stop();
    });

    it("never aborts once stopped", () => {
      const limits = streamLimits(1_000, 2_000);
      limits.stop();
      vi.advanceTimersByTime(10_000);
      expect(limits.signal.aborted).toEqual(false);
    });
  });
});
