import { CSRF } from "@shared/constants";
import { NetworkError } from "./errors";
import type { AskEvent } from "./streamFetch";
import { StreamRequestError, streamFetch } from "./streamFetch";

const encoder = new TextEncoder();

function streamOf(chunks: Uint8Array[]) {
  let released = false;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next) {
        controller.enqueue(next);
      } else {
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    body,
    state: () => ({ released, cancelled }),
    markReleased: () => {
      released = true;
    },
  };
}

function mockFetch(response: Response) {
  const spy = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

function sse(chunks: Uint8Array[], init: ResponseInit = { status: 200 }) {
  return new Response(streamOf(chunks).body, init);
}

async function collect(iter: AsyncIterable<AskEvent>) {
  const out: AskEvent[] = [];
  for await (const e of iter) {
    out.push(e);
  }
  return out;
}

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const doneData = {
  conversationId: null,
  usage: { inputTokens: 1, outputTokens: 2 },
  timings: { retrievalMs: 1, totalMs: 2 },
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = `${CSRF.cookieName}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
});

describe("streamFetch", () => {
  it("parses frames split at every byte boundary, including inside UTF-8", async () => {
    const text =
      frame("conversation", { id: "c1" }) +
      frame("block", {
        index: 0,
        kind: "paragraph",
        markdown: "héllo 日本 😀",
        citations: [],
      }) +
      frame("done", doneData);
    const bytes = encoder.encode(text);
    for (let i = 1; i < bytes.length; i++) {
      mockFetch(sse([bytes.slice(0, i), bytes.slice(i)]));
      const events = await collect(streamFetch("ai.ask", { query: "q" }));
      expect(events.map((e) => e.event)).toEqual([
        "conversation",
        "block",
        "done",
      ]);
      const block = events[1];
      expect(block.event === "block" && block.data.markdown).toBe(
        "héllo 日本 😀"
      );
    }
  });

  it("ignores heartbeat comments, handles CRLF and multi-line data", async () => {
    const text =
      ": heartbeat\r\n\r\n" +
      'event: status\r\ndata: {"phase":\r\ndata: "searching"}\r\n\r\n';
    mockFetch(sse([encoder.encode(text)]));
    const events = await collect(streamFetch("ai.ask", {}));
    expect(events).toEqual([{ event: "status", data: { phase: "searching" } }]);
  });

  it("handles a CRLF pair split across chunks", async () => {
    mockFetch(
      sse([
        encoder.encode('event: status\r\ndata: {"phase":"generating"}\r'),
        encoder.encode("\n\r"),
        encoder.encode("\n"),
      ])
    );
    const events = await collect(streamFetch("ai.ask", {}));
    expect(events).toHaveLength(1);
  });

  it("skips unknown events", async () => {
    mockFetch(
      sse([
        encoder.encode(frame("mystery", { a: 1 }) + frame("done", doneData)),
      ])
    );
    const events = await collect(streamFetch("ai.ask", {}));
    expect(events.map((e) => e.event)).toEqual(["done"]);
  });

  it("surfaces one failed event for malformed JSON and stops", async () => {
    const text =
      frame("block", {
        index: 0,
        kind: "paragraph",
        markdown: "a",
        citations: [],
      }) +
      "event: sources\ndata: {nope\n\n" +
      frame("done", doneData);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(text));
      },
      cancel() {
        cancelled = true;
      },
    });
    mockFetch(new Response(body, { status: 200 }));
    const events = await collect(streamFetch("ai.ask", {}));
    expect(events.map((e) => e.event)).toEqual(["block", "failed"]);
    expect(events[1]).toEqual({
      event: "failed",
      data: { reason: "error", partial: true },
    });
    expect(cancelled).toBe(true);
  });

  it("rejects with status and message on 403", async () => {
    mockFetch(
      new Response(
        JSON.stringify({
          error: "authorization_error",
          message: "No AI for you",
        }),
        { status: 403 }
      )
    );
    const err = await collect(streamFetch("ai.ask", {})).catch((e) => e);
    expect(err).toBeInstanceOf(StreamRequestError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("authorization_error");
    expect(err.message).toBe("No AI for you");
  });

  it("maps 429 and 400", async () => {
    mockFetch(new Response("{}", { status: 429 }));
    const err = await collect(streamFetch("ai.ask", {})).catch((e) => e);
    expect(err).toBeInstanceOf(StreamRequestError);
    expect(err.message).toBe("Too many requests, try again in a minute.");
    expect(err.status).toBe(429);

    mockFetch(new Response('{"message":"bad"}', { status: 400 }));
    const err2 = await collect(streamFetch("ai.ask", {})).catch((e) => e);
    expect(err2.status).toBe(400);
    expect(err2.message).toBe("bad");
  });

  it("exposes Retry-After seconds on a 429, ignoring invalid values", async () => {
    mockFetch(
      new Response("{}", { status: 429, headers: { "Retry-After": "42" } })
    );
    const err = await collect(streamFetch("ai.ask", {})).catch((e) => e);
    expect(err.retryAfter).toBe(42);

    for (const bad of ["soon", "-5", "0", "1.5"]) {
      mockFetch(
        new Response("{}", { status: 429, headers: { "Retry-After": bad } })
      );
      const e2 = await collect(streamFetch("ai.ask", {})).catch((e) => e);
      expect(e2.retryAfter).toBeUndefined();
    }
  });

  it("rejects with NetworkError when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("boom")));
    await expect(collect(streamFetch("ai.ask", {}))).rejects.toBeInstanceOf(
      NetworkError
    );
  });

  it("ends normally when aborted mid-stream and cancels the reader", async () => {
    const controller = new AbortController();
    const s = streamOf([
      encoder.encode(frame("conversation", { id: "c1" })),
      encoder.encode(frame("done", doneData)),
    ]);
    mockFetch(new Response(s.body, { status: 200 }));
    const events: AskEvent[] = [];
    for await (const e of streamFetch(
      "ai.ask",
      {},
      { signal: controller.signal }
    )) {
      events.push(e);
      controller.abort();
    }
    expect(events.map((e) => e.event)).toEqual(["conversation"]);
    expect(controller.signal.aborted).toBe(true);
    expect(s.state().cancelled).toBe(true);
  });

  it("ends normally when aborted while waiting for the next chunk", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(frame("conversation", { id: "c1" })));
      },
    });
    mockFetch(new Response(body, { status: 200 }));
    const events: AskEvent[] = [];
    for await (const e of streamFetch(
      "ai.ask",
      {},
      { signal: controller.signal }
    )) {
      events.push(e);
      setTimeout(() => controller.abort(), 0);
    }
    expect(events).toHaveLength(1);
  });

  it("ends normally when already aborted before start, without fetching", async () => {
    const controller = new AbortController();
    controller.abort();
    const spy = mockFetch(sse([]));
    const events = await collect(
      streamFetch("ai.ask", {}, { signal: controller.signal })
    );
    expect(events).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("ends normally when fetch rejects because of abort", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      })
    );
    const events = await collect(
      streamFetch("ai.ask", {}, { signal: controller.signal })
    );
    expect(events).toEqual([]);
  });

  it("sends CSRF header, credentials, JSON content type and API headers", async () => {
    document.cookie = `${CSRF.cookieName}=tok123`;
    const spy = mockFetch(sse([encoder.encode(frame("done", doneData))]));
    const controller = new AbortController();
    await collect(
      streamFetch("ai.ask", { query: "hi" }, { signal: controller.signal })
    );
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("/api/ai.ask");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.body).toBe('{"query":"hi"}');
    expect(init.signal).toBe(controller.signal);
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get(CSRF.headerName)).toBe("tok123");
    expect(headers.get("x-api-version")).toBe("4");
  });

  it("accepts a leading slash in the path", async () => {
    const spy = mockFetch(sse([]));
    await collect(streamFetch("/ai.ask", {}));
    expect(spy.mock.calls[0][0]).toBe("/api/ai.ask");
  });

  it("releases the reader lock when finished", async () => {
    const s = streamOf([encoder.encode(frame("done", doneData))]);
    mockFetch(new Response(s.body, { status: 200 }));
    await collect(streamFetch("ai.ask", {}));
    expect(s.body.locked).toBe(false);
  });
});
