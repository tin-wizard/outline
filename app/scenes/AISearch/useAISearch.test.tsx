import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type * as StreamModule from "~/utils/streamFetch";
import { client } from "~/utils/ApiClient";
import { NotFoundError, RateLimitExceededError } from "~/utils/errors";
import { StreamRequestError, streamFetch } from "~/utils/streamFetch";
import type { ChatState } from "./model";
import { block, controlled, done } from "~/test/askStream";
import { useAISearch } from "./useAISearch";

vi.mock("~/utils/streamFetch", async (importOriginal) => ({
  ...(await importOriginal<typeof StreamModule>()),
  streamFetch: vi.fn(),
}));

const mocked = vi.mocked(streamFetch);

type Api = ReturnType<typeof useAISearch>;

function mount() {
  const ref: { current: Api | null } = { current: null };
  function Harness() {
    ref.current = useAISearch();
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(<Harness />));
  const api = () => {
    if (!ref.current) {
      throw new Error("not mounted");
    }
    return ref.current;
  };
  return { api, unmount: () => act(() => root.unmount()) };
}

const lastTurn = (state: ChatState) => state.turns[state.turns.length - 1];

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => mocked.mockReset());

describe("useAISearch", () => {
  it("streams events into the turn and follows up with the conversation id", async () => {
    const { api } = mount();
    const first = controlled();
    act(() => api().ask("First?", { collectionId: "col" }));
    expect(api().streaming).toBe(true);
    expect(mocked.mock.calls[0][0]).toBe("ai.ask");
    expect(mocked.mock.calls[0][1]).toMatchObject({
      query: "First?",
      collectionId: "col",
      conversationId: undefined,
    });

    await first.push(
      { event: "conversation", data: { id: "c1" } },
      block(0),
      block(1)
    );
    expect(lastTurn(api().state).blocks.map((b) => b.markdown)).toEqual([
      "b0",
      "b1",
    ]);
    await first.push(done("c1"));
    await first.end();
    expect(lastTurn(api().state).status).toBe("done");
    expect(api().streaming).toBe(false);

    const second = controlled();
    act(() => api().ask("Follow up?", {}));
    expect(mocked.mock.calls[1][1]).toMatchObject({
      query: "Follow up?",
      conversationId: "c1",
    });
    await second.end();
  });

  it("Stop aborts the request and shows stopped", async () => {
    const { api } = mount();
    const stream = controlled();
    act(() => api().ask("Q?", {}));
    await stream.push(block(0));
    await act(async () => {
      api().stop();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(stream.signal?.aborted).toBe(true);
    expect(lastTurn(api().state)).toMatchObject({ status: "stopped" });
    expect(lastTurn(api().state).blocks).toHaveLength(1);
  });

  it("keeps partial blocks and the reason when the server fails the turn", async () => {
    const { api } = mount();
    const stream = controlled();
    act(() => api().ask("Q?", {}));
    await stream.push(block(0), {
      event: "failed",
      data: { reason: "unverified", partial: true },
    });
    await stream.end();
    expect(lastTurn(api().state)).toMatchObject({
      status: "failed",
      problem: "unverified",
    });
    expect(lastTurn(api().state).blocks).toHaveLength(1);
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rateLimited"],
    [500, "error"],
  ])("maps HTTP %i to %s", async (status, problem) => {
    const { api } = mount();
    // eslint-disable-next-line require-yield
    mocked.mockImplementationOnce(async function* () {
      throw new StreamRequestError("x", status);
    });
    await act(async () => api().ask("Q?", {}));
    expect(lastTurn(api().state)).toMatchObject({ status: "failed", problem });
  });

  it("passes the Retry-After seconds of a 429 to the turn", async () => {
    const { api } = mount();
    // eslint-disable-next-line require-yield
    mocked.mockImplementationOnce(async function* () {
      throw new StreamRequestError("x", 429, undefined, 30);
    });
    await act(async () => api().ask("Q?", {}));
    expect(lastTurn(api().state)).toMatchObject({
      problem: "rateLimited",
      retryAfter: 30,
    });
  });

  it("treats a stream that ends without done or failed as an error", async () => {
    const { api } = mount();
    const stream = controlled();
    act(() => api().ask("Q?", {}));
    await stream.end();
    expect(lastTurn(api().state)).toMatchObject({
      status: "failed",
      problem: "error",
    });
  });

  it("New conversation drops history and detaches the old stream", async () => {
    const { api } = mount();
    const old = controlled();
    act(() => api().ask("Q?", {}));
    await old.push({ event: "conversation", data: { id: "c1" } });
    await act(async () => api().reset());
    expect(api().state.turns).toHaveLength(0);
    expect(api().state.conversationId).toBeNull();
    expect(old.signal?.aborted).toBe(true);

    const fresh = controlled();
    act(() => api().ask("New?", {}));
    expect(mocked.mock.calls[1][1]).toMatchObject({
      conversationId: undefined,
    });
    await fresh.end();
  });

  describe("feedback", () => {
    const UUID = "0b8c7a4e-5b2f-4f5e-9d3a-1f2e3d4c5b6a";
    const post = vi.mocked(client.post);

    async function finishedTurn() {
      const view = mount();
      const stream = controlled();
      act(() => view.api().ask("Q?", {}));
      await stream.push(block(0), done("c", UUID));
      await stream.end();
      post.mockReset();
      return view;
    }

    it("sends up, down, then clear in order and tracks the rating", async () => {
      const { api } = await finishedTurn();
      post.mockResolvedValue({});
      for (const [click, rating, expected] of [
        ["up", "up", "up"],
        ["down", "down", "down"],
        ["down", "clear", null],
      ] as const) {
        await act(async () => api().rate(1, click));
        expect(post).toHaveBeenLastCalledWith("ai.feedback", {
          usageId: UUID,
          rating,
        });
        expect(lastTurn(api().state).feedback).toMatchObject({
          rating: expected,
          pending: false,
        });
      }
      expect(post).toHaveBeenCalledTimes(3);
    });

    it("is optimistic, disabled while pending, and sends one request", async () => {
      const { api } = await finishedTurn();
      let resolve: () => void = () => {};
      post.mockReturnValue(new Promise<void>((r) => (resolve = r)));
      act(() => api().rate(1, "up"));
      expect(lastTurn(api().state).feedback).toMatchObject({
        rating: "up",
        pending: true,
      });
      act(() => api().rate(1, "down"));
      expect(post).toHaveBeenCalledTimes(1);
      await act(async () => resolve());
      expect(lastTurn(api().state).feedback?.pending).toBe(false);
    });

    it("rolls back on failure and maps 429 / 404", async () => {
      const { api } = await finishedTurn();
      post.mockRejectedValueOnce(new Error("boom"));
      await act(async () => api().rate(1, "up"));
      expect(lastTurn(api().state).feedback).toMatchObject({
        rating: null,
        error: "failed",
      });
      post.mockRejectedValueOnce(new RateLimitExceededError("slow"));
      await act(async () => api().rate(1, "up"));
      expect(lastTurn(api().state).feedback?.error).toBe("rateLimited");
      post.mockRejectedValueOnce(new NotFoundError());
      await act(async () => api().rate(1, "up"));
      expect(lastTurn(api().state).feedback?.hidden).toBe(true);
    });

    it("does nothing without a usageId", async () => {
      const view = mount();
      const stream = controlled();
      act(() => view.api().ask("Q?", {}));
      await stream.push(block(0), done("c"));
      await stream.end();
      post.mockReset();
      await act(async () => view.api().rate(1, "up"));
      expect(post).not.toHaveBeenCalled();
    });
  });
});
