import type { AskEvent } from "~/utils/streamFetch";
import type { ChatState } from "./model";
import { chatReducer, citedSources, initialChatState } from "./model";

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

const done = (conversationId: string | null): AskEvent => ({
  event: "done",
  data: {
    conversationId,
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
      { n: 1, title: "A", url: "/doc/a#h-x", collectionName: "Eng" },
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

  it("records a notice without changing the phase", () => {
    const state = run([
      {
        event: "status",
        data: { phase: "notice", message: "Conversation expired" },
      },
    ]);
    expect(state.turns[0]).toMatchObject({
      status: "searching",
      notice: "Conversation expired",
    });
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
