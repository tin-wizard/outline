import type { AskEvent } from "~/utils/streamFetch";
import type { ChatState } from "./model";
import { canRate, chatReducer, citedSources, initialChatState } from "./model";

const run = (events: AskEvent[], from: ChatState = initialChatState) =>
  events.reduce<ChatState>(
    (state, event) => chatReducer(state, { type: "event", event }),
    chatReducer(from, { type: "submit", question: "Q?", scope: {} })
  );

const block = (index: number, markdown = "text"): AskEvent => ({
  event: "block",
  data: {
    index,
    kind: "paragraph",
    markdown,
    citations: [{ n: 1, documentId: "d", title: "A", url: "/doc/a#h-x" }],
  },
});

const done = (
  conversationId: string | null,
  usageId: string | null = null
): AskEvent => ({
  event: "done",
  data: {
    conversationId,
    usageId,
    usage: { inputTokens: 1, outputTokens: 1 },
    timings: { retrievalMs: 1, totalMs: 2 },
  },
});

describe("chatReducer", () => {
  it("walks searching -> generating -> done and keeps the conversation id", () => {
    const state = run([
      { event: "conversation", data: { id: "c1" } },
      { event: "status", data: { phase: "searching" } },
      {
        event: "sources",
        data: [
          {
            n: 1,
            documentId: "d",
            title: "A",
            url: "/doc/a",
            collectionName: "Eng",
          },
        ],
      },
      { event: "status", data: { phase: "generating" } },
      block(0),
      block(1),
      done("c1"),
    ]);
    const turn = state.turns[0];
    expect(turn.status).toBe("done");
    expect(turn.blocks.map((b) => b.index)).toEqual([0, 1]);
    expect(state.conversationId).toBe("c1");
    expect(citedSources(turn)).toEqual([
      {
        n: 1,
        title: "A",
        sections: [{ url: "/doc/a#h-x" }],
        collectionName: "Eng",
      },
    ]);
  });

  it("drops the conversation id when the turn was not stored", () => {
    const state = run([
      { event: "conversation", data: { id: "c1" } },
      block(0),
      done(null),
    ]);
    expect(state.turns[0].status).toBe("done");
    expect(state.turns[0].blocks).toHaveLength(1);
    expect(state.conversationId).toBeNull();
  });

  it("ignores a replayed block index", () => {
    expect(run([block(0), block(0)]).turns[0].blocks).toHaveLength(1);
  });

  it("keeps partial blocks when the turn fails", () => {
    const state = run([
      block(0),
      { event: "failed", data: { reason: "unverified", partial: true } },
    ]);
    expect(state.turns[0]).toMatchObject({
      status: "failed",
      problem: "unverified",
    });
    expect(state.turns[0].blocks).toHaveLength(1);
  });

  it("keeps only the notice code, never the server's English message", () => {
    const state = run([
      {
        event: "status",
        data: {
          phase: "notice",
          notice: "conversation_new",
          message: "Conversation expired",
        },
      },
    ]);
    expect(state.turns[0]).toMatchObject({
      status: "searching",
      notice: "conversation_new",
    });
    expect(JSON.stringify(state)).not.toContain("Conversation expired");
    const legacy = run([
      { event: "status", data: { phase: "notice", message: "Old server" } },
    ]);
    expect(legacy.turns[0].notice).toBe("unknown");
  });

  it("ignores events after the turn ended", () => {
    const state = run([done("c"), block(5)]);
    expect(state.turns[0].blocks).toHaveLength(0);
  });

  it("marks stopped, request failures and a stream that ends early", () => {
    const submitted = chatReducer(initialChatState, {
      type: "submit",
      question: "Q",
      scope: {},
    });
    expect(chatReducer(submitted, { type: "stopped" }).turns[0].status).toBe(
      "stopped"
    );
    expect(
      chatReducer(submitted, { type: "requestFailed", problem: "rateLimited" })
        .turns[0]
    ).toMatchObject({ status: "failed", problem: "rateLimited" });
    expect(chatReducer(submitted, { type: "ended" }).turns[0]).toMatchObject({
      status: "failed",
      problem: "error",
    });
  });

  it("resets the conversation", () => {
    expect(
      chatReducer(run([{ event: "conversation", data: { id: "c" } }]), {
        type: "reset",
      })
    ).toEqual(initialChatState);
  });
});

describe("chatReducer with malformed events", () => {
  // The payload is network JSON; cast to simulate what the wire could carry.
  const wire = (event: string, data: unknown) =>
    ({ event, data }) as unknown as AskEvent;

  it("never throws and leaves the turn usable", () => {
    const bad: AskEvent[] = [
      wire("block", null),
      wire("block", {}),
      wire("block", {
        index: 0,
        kind: "paragraph",
        markdown: 5,
        citations: [],
      }),
      wire("block", {
        index: 0,
        kind: "paragraph",
        markdown: "x",
        citations: null,
      }),
      wire("block", { index: 1, kind: "script", markdown: "x", citations: [] }),
      wire("block", {
        index: "2",
        kind: "paragraph",
        markdown: "x",
        citations: [],
      }),
      wire("status", null),
      wire("status", { phase: "exploding" }),
      wire("status", { phase: "notice" }),
      wire("sources", null),
      wire("sources", "nope"),
      wire("conversation", { id: 7 }),
      wire("conversation", null),
      wire("mystery", { a: 1 }),
      wire("done", null),
    ];
    const state = run(bad);
    expect(state.turns[0].status).toBe("searching");
    expect(state.turns[0].blocks).toHaveLength(0);
    expect(state.conversationId).toBeNull();
    // and the page keeps working afterwards
    const next = chatReducer(state, { type: "event", event: block(0) });
    expect(next.turns[0].blocks).toHaveLength(1);
    expect(
      chatReducer(next, { type: "event", event: done("c") }).turns[0].status
    ).toBe("done");
  });

  it("drops invalid citations and sources entries", () => {
    const state = run([
      wire("block", {
        index: 0,
        kind: "paragraph",
        markdown: "x",
        citations: [
          null,
          { n: "1" },
          { n: 1, title: "A", url: "/doc/a", documentId: "d" },
        ],
      }),
      wire("sources", [
        null,
        { n: 1 },
        { n: 2, title: "B", url: "/doc/b", documentId: "d" },
      ]),
    ]);
    expect(state.turns[0].blocks[0].citations).toHaveLength(1);
    expect(state.turns[0].sources).toHaveLength(1);
  });

  it("only moves phases forward", () => {
    const afterBlock = run([
      { event: "status", data: { phase: "generating" } },
      block(0),
      { event: "status", data: { phase: "searching" } },
    ]);
    expect(afterBlock.turns[0].status).toBe("generating");
    const late = run([
      { event: "status", data: { phase: "generating" } },
      { event: "status", data: { phase: "searching" } },
    ]);
    expect(late.turns[0].status).toBe("generating");
  });

  it("keeps the quota failure reason", () => {
    const state = run([wire("failed", { reason: "quota", partial: false })]);
    expect(state.turns[0]).toMatchObject({
      status: "failed",
      problem: "quota",
    });
  });

  it("treats an unknown failure reason as an error and a non-string conversation id as none", () => {
    const state = run([wire("failed", { reason: "weird", partial: false })]);
    expect(state.turns[0].problem).toBe("error");
    const d = run([wire("done", { conversationId: 5 })]);
    expect(d.conversationId).toBeNull();
  });

  it("lists every distinct section of a source", () => {
    const cite = (url: string) => ({ n: 1, documentId: "d", title: "A", url });
    const state = run([
      wire("block", {
        index: 0,
        kind: "paragraph",
        markdown: "a",
        citations: [cite("/doc/a#h-x")],
      }),
      wire("block", {
        index: 1,
        kind: "paragraph",
        markdown: "b",
        citations: [cite("/doc/a#h-y"), cite("/doc/a#h-x")],
      }),
    ]);
    expect(citedSources(state.turns[0])[0].sections.map((x) => x.url)).toEqual([
      "/doc/a#h-x",
      "/doc/a#h-y",
    ]);
  });
});

describe("usageId and feedback", () => {
  const UUID = "0b8c7a4e-5b2f-4f5e-9d3a-1f2e3d4c5b6a";
  const finished = () => run([done("c", UUID)]);

  it("stores a valid usageId and nulls anything else", () => {
    expect(finished().turns[0].usageId).toBe(UUID);
    for (const bad of ["not-a-uuid", "../x", 5, null, undefined, ""]) {
      const event = {
        event: "done",
        data: { conversationId: null, usageId: bad },
      } as unknown as AskEvent;
      expect(run([event]).turns[0].usageId).toBeNull();
    }
  });

  const act = (
    state: ChatState,
    ...actions: Parameters<typeof chatReducer>[1][]
  ) => actions.reduce(chatReducer, state);

  it("applies, confirms and rolls back ratings", () => {
    let state = act(finished(), {
      type: "feedbackStart",
      turnId: 1,
      rating: "up",
    });
    expect(state.turns[0].feedback).toMatchObject({
      rating: "up",
      pending: true,
      previous: null,
    });
    state = act(state, { type: "feedbackDone", turnId: 1 });
    expect(state.turns[0].feedback).toMatchObject({
      rating: "up",
      pending: false,
      saved: true,
    });
    state = act(state, { type: "feedbackStart", turnId: 1, rating: "down" });
    state = act(state, { type: "feedbackFailed", turnId: 1, error: "failed" });
    expect(state.turns[0].feedback).toMatchObject({
      rating: "up",
      pending: false,
      error: "failed",
    });
  });

  it("ignores a second start while pending", () => {
    const state = act(
      finished(),
      { type: "feedbackStart", turnId: 1, rating: "up" },
      { type: "feedbackStart", turnId: 1, rating: "down" }
    );
    expect(state.turns[0].feedback?.rating).toBe("up");
  });

  it("hides the buttons when refused", () => {
    const state = act(
      finished(),
      { type: "feedbackStart", turnId: 1, rating: "up" },
      { type: "feedbackFailed", turnId: 1, error: "refused" }
    );
    expect(canRate(state.turns[0])).toBe(false);
  });

  it("does not allow feedback without usageId or on unfinished/failed turns", () => {
    expect(canRate(run([done("c")]).turns[0])).toBe(false);
    expect(canRate(run([block(0)]).turns[0])).toBe(false);
    const failed = run([
      block(0),
      { event: "failed", data: { reason: "unverified", partial: true } },
    ]);
    expect(canRate(failed.turns[0])).toBe(false);
    const state = act(failed, {
      type: "feedbackStart",
      turnId: 1,
      rating: "up",
    });
    expect(state.turns[0].feedback).toBeUndefined();
  });
});
