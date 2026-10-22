import type {
  ProviderErrorKind,
  ProviderStreamEvent,
  StreamingProvider,
  StreamRequest,
} from "../contract";
import {
  AllProvidersFailedError,
  FIRST_EVENT_TIMEOUT_MS,
  streamWithFallback,
} from "./chain";
import type { ProviderHealth } from "./health";

class KindError extends Error {
  constructor(public kind: ProviderErrorKind) {
    super(kind);
  }
}

const text = { type: "text" as const, text: "Hi.", citations: [] };

type Behaviour =
  | { fail: ProviderErrorKind }
  | { yieldThenFail: ProviderErrorKind }
  | "ok"
  | "silent";

function fakeProvider(id: string, behaviour: Behaviour) {
  const stream = vi.fn(async function* (
    request: StreamRequest
  ): AsyncGenerator<ProviderStreamEvent> {
    if (behaviour === "ok") {
      yield { ...text, text: id };
      return;
    }
    if (behaviour === "silent") {
      await new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      });
      return;
    }
    if ("yieldThenFail" in behaviour) {
      yield text;
      throw new KindError(behaviour.yieldThenFail);
    }
    throw new KindError(behaviour.fail);
  });
  const provider: StreamingProvider = {
    id,
    model: `${id}-model`,
    stream,
    classify: (error) => (error instanceof KindError ? error.kind : "other"),
  };
  return { provider, stream };
}

function fakeHealth(open: string[] = []) {
  return {
    isOpen: (id: string) => open.includes(id),
    trip: vi.fn<ProviderHealth["trip"]>(),
  };
}

function makeRequest(): StreamRequest {
  return {
    question: "q",
    sources: [],
    history: [],
    signal: new AbortController().signal,
    progress: { inputTokens: null, outputChars: 0 },
  };
}

async function collect(gen: AsyncGenerator<ProviderStreamEvent>) {
  const events: ProviderStreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("streamWithFallback", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls over to the second provider when the first throws billing before any event", async () => {
    const a = fakeProvider("a", { fail: "billing" });
    const b = fakeProvider("b", "ok");
    const health = fakeHealth();
    const request = makeRequest();

    const events = await collect(
      streamWithFallback([a.provider, b.provider], request, health)
    );

    expect(events).toEqual([{ ...text, text: "b" }]);
    expect(request.progress?.served).toEqual({
      provider: "b",
      model: "b-model",
    });
    expect(health.trip).toHaveBeenCalledWith("a", "billing");
  });

  it("does not fall over after the first event", async () => {
    const a = fakeProvider("a", { yieldThenFail: "overloaded" });
    const b = fakeProvider("b", "ok");

    await expect(
      collect(
        streamWithFallback(
          [a.provider, b.provider],
          makeRequest(),
          fakeHealth()
        )
      )
    ).rejects.toMatchObject({ kind: "overloaded" });
    expect(b.stream).not.toHaveBeenCalled();
  });

  it("does not fall over on bad_request", async () => {
    const a = fakeProvider("a", { fail: "bad_request" });
    const b = fakeProvider("b", "ok");

    await expect(
      collect(
        streamWithFallback(
          [a.provider, b.provider],
          makeRequest(),
          fakeHealth()
        )
      )
    ).rejects.toBeInstanceOf(KindError);
    expect(b.stream).not.toHaveBeenCalled();
  });

  it("an aborted request is not failed over and not tripped", async () => {
    const controller = new AbortController();
    const request = { ...makeRequest(), signal: controller.signal };
    controller.abort();
    const a = fakeProvider("a", { fail: "network" });
    const b = fakeProvider("b", "ok");
    const health = fakeHealth();

    await expect(
      collect(streamWithFallback([a.provider, b.provider], request, health))
    ).rejects.toMatchObject({ kind: "network" });
    expect(health.trip).not.toHaveBeenCalled();
    expect(b.stream).not.toHaveBeenCalled();
  });

  it("skips an open provider", async () => {
    const a = fakeProvider("a", "ok");
    const b = fakeProvider("b", "ok");

    const events = await collect(
      streamWithFallback(
        [a.provider, b.provider],
        makeRequest(),
        fakeHealth(["a"])
      )
    );

    expect(events).toEqual([{ ...text, text: "b" }]);
    expect(a.stream).not.toHaveBeenCalled();
  });

  it("tries open providers when all are open", async () => {
    const a = fakeProvider("a", "ok");
    const b = fakeProvider("b", "ok");

    const events = await collect(
      streamWithFallback(
        [a.provider, b.provider],
        makeRequest(),
        fakeHealth(["a", "b"])
      )
    );

    expect(events).toEqual([{ ...text, text: "a" }]);
  });

  it("a provider silent for FIRST_EVENT_TIMEOUT_MS is failed over", async () => {
    vi.useFakeTimers();
    const a = fakeProvider("a", "silent");
    const b = fakeProvider("b", "ok");
    const health = fakeHealth();
    const request = makeRequest();

    const pending = collect(
      streamWithFallback([a.provider, b.provider], request, health)
    );
    await vi.advanceTimersByTimeAsync(FIRST_EVENT_TIMEOUT_MS);

    await expect(pending).resolves.toEqual([{ ...text, text: "b" }]);
    expect(health.trip).toHaveBeenCalledWith("a", "network");
    expect(request.signal?.aborted).toBe(false);
  });

  it("a lone provider is not subject to FIRST_EVENT_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const a = fakeProvider("a", "silent");
    const controller = new AbortController();
    const request = { ...makeRequest(), signal: controller.signal };
    let settled = false;

    const pending = collect(
      streamWithFallback([a.provider], request, fakeHealth())
    ).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(FIRST_EVENT_TIMEOUT_MS * 3);
    expect(settled).toBe(false);

    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
  });

  it("a lone provider failing with billing throws AllProvidersFailedError with one attempt", async () => {
    const a = fakeProvider("a", { fail: "billing" });

    const error = await collect(
      streamWithFallback([a.provider], makeRequest(), fakeHealth())
    ).catch((err: Error) => err);

    expect(error).toBeInstanceOf(AllProvidersFailedError);
    expect(error instanceof AllProvidersFailedError && error.attempts).toEqual([
      { provider: "a", kind: "billing" },
    ]);
  });

  it("a lone provider failing with bad_request rethrows the original error", async () => {
    const a = fakeProvider("a", { fail: "bad_request" });

    await expect(
      collect(streamWithFallback([a.provider], makeRequest(), fakeHealth()))
    ).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("several providers all failing throws AllProvidersFailedError with attempts in order", async () => {
    const a = fakeProvider("a", { fail: "rate_limit" });
    const b = fakeProvider("b", { fail: "auth" });
    const c = fakeProvider("c", { fail: "overloaded" });

    const error = await collect(
      streamWithFallback(
        [a.provider, b.provider, c.provider],
        makeRequest(),
        fakeHealth()
      )
    ).catch((err: Error) => err);

    expect(error instanceof AllProvidersFailedError && error.attempts).toEqual([
      { provider: "a", kind: "rate_limit" },
      { provider: "b", kind: "auth" },
      { provider: "c", kind: "overloaded" },
    ]);
  });
});
