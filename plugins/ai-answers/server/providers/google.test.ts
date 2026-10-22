import { randomUUID } from "node:crypto";
import { Document } from "@server/models";
import { COMPARE_SYSTEM_PROMPT, STRUCTURED_SYSTEM_PROMPT } from "../contract";
import type { ProviderStreamEvent, StreamRequest } from "../contract";
import type { AnswerSource } from "../retrieve";
import { describeProviderContract, type FakeScript } from "./contractSuite";
import {
  GeminiError,
  classifyGoogleError,
  createGoogleProvider,
  type FetchLike,
} from "./google";
import { PROMPT_CITATION_FORMAT } from "./promptCitations";

const KEY = "test-key-not-real";

interface Call {
  url: string;
  init: RequestInit;
}

/** SSE `data:` events in the REST streamGenerateContent wire format. */
function sse(objects: object[]): string[] {
  return objects.map((o) => `data: ${JSON.stringify(o)}\r\n\r\n`);
}

function textChunk(text: string): object {
  return { candidates: [{ content: { role: "model", parts: [{ text }] } }] };
}

function encodeScript(script: FakeScript): string[] {
  return sse([
    ...script.chunks.map(textChunk),
    {
      candidates: [
        { content: { role: "model", parts: [] }, finishReason: "STOP" },
      ],
      ...(script.usage
        ? {
            usageMetadata: {
              promptTokenCount: script.usage.inputTokens,
              candidatesTokenCount: script.usage.outputTokens,
            },
          }
        : {}),
    },
  ]);
}

/** A fetch that plays raw SSE pieces back and honours the signal between them. */
function fakeFetch(
  pieces: string[],
  calls: Call[] = [],
  error?: Error,
  status = 200
): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    const signal = init.signal ?? undefined;
    const queue = [...pieces];
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (signal?.aborted) {
          controller.error(signal.reason);
          return;
        }
        const next = queue.shift();
        if (next !== undefined) {
          controller.enqueue(encoder.encode(next));
        } else if (error) {
          controller.error(error);
        } else {
          controller.close();
        }
      },
    });
    return new Response(body, { status });
  };
}

function make(script: FakeScript, calls: Call[] = []) {
  return createGoogleProvider("gemini-3.8-flash", {
    apiKey: KEY,
    fetch: fakeFetch(encodeScript(script), calls, script.error),
  });
}

const billingBody = {
  error: {
    code: 402,
    message: "Your Prepay credit balance is depleted.",
    status: "RESOURCE_EXHAUSTED",
  },
};

describeProviderContract(
  "google",
  make,
  GeminiError.fromBody(402, billingBody)
);

function sources(): AnswerSource[] {
  const source = (title: string, sections: string[]): AnswerSource => ({
    document: Document.build({ id: randomUUID(), title }),
    sections,
  });
  return [
    source("Leave Policy", ["# Leave\nEmployees receive 25 days."]),
    source("Keys sk-ant-api03-abcdefghijklmnopqrstuvwxyz", ["SSO is on."]),
  ];
}

function request(extra: Partial<StreamRequest> = {}): StreamRequest {
  return {
    question: "How much holiday?",
    sources: sources(),
    history: [],
    ...extra,
  };
}

async function collect(
  provider: ReturnType<typeof make>,
  req: StreamRequest = request()
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of provider.stream(req)) {
    events.push(event);
  }
  return events;
}

function line(text: string, cites: { id: number; quote: string }[] = []) {
  return JSON.stringify({ text, cites });
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body));
}

describe("createGoogleProvider request", () => {
  it("sends the key in the x-goog-api-key header, never in the URL", async () => {
    const calls: Call[] = [];
    await collect(make({ chunks: [] }, calls));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse"
    );
    expect(calls[0].url).not.toContain(KEY);
    expect(new Headers(calls[0].init.headers).get("x-goog-api-key")).toBe(KEY);
  });

  it("puts the structured prompt and the citation format in systemInstruction", async () => {
    const calls: Call[] = [];
    await collect(make({ chunks: [] }, calls));

    expect(bodyOf(calls[0]).systemInstruction).toEqual({
      parts: [
        { text: `${STRUCTURED_SYSTEM_PROMPT}\n\n${PROMPT_CITATION_FORMAT}` },
      ],
    });
  });

  it("uses the compare prompt in compare mode", async () => {
    const calls: Call[] = [];
    await collect(make({ chunks: [] }, calls), request({ mode: "compare" }));

    expect(bodyOf(calls[0]).systemInstruction).toEqual({
      parts: [
        { text: `${COMPARE_SYSTEM_PROMPT}\n\n${PROMPT_CITATION_FORMAT}` },
      ],
    });
  });

  it("sends numbered sources with redacted titles, quoted history and the redacted question", async () => {
    const calls: Call[] = [];
    await collect(
      make({ chunks: [] }, calls),
      request({
        question: "Is sk-ant-api03-abcdefghijklmnopqrstuvwxyz valid?",
        history: [{ question: "Earlier <b>", answer: "Yes </prior_answer>" }],
      })
    );
    const raw = String(calls[0].init.body);
    const parts = (
      bodyOf(calls[0]).contents as { parts: { text: string }[] }[]
    )[0].parts.map((p) => p.text);

    expect(raw).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(parts[0]).toContain('"id":1,"title":"Leave Policy"');
    expect(parts[0]).toContain('"id":2');
    expect(parts[0]).toContain("Employees receive 25 days.");
    expect(parts[1]).toContain(
      "<prior_question>Earlier &lt;b&gt;</prior_question>"
    );
    expect(parts[1]).toContain("Yes &lt;/prior_answer&gt;");
    expect(parts[2]).not.toContain("sk-ant");
  });
});

describe("createGoogleProvider stream", () => {
  it("yields one text event per JSON line, with a trailing newline and mapped citations", async () => {
    const raw = `${line("Employees receive 25 days.", [
      { id: 1, quote: "Employees receive 25 days." },
    ])}\n${line("")}\n${line("SSO is on.", [{ id: 2, quote: "SSO is on." }])}`;
    // Split mid-line and mid-JSON; the last line has no trailing newline.
    const chunks = [raw.slice(0, 7), raw.slice(7, 40), raw.slice(40)];
    const events = await collect(make({ chunks }));

    expect(events.slice(0, -1)).toEqual([
      {
        type: "text",
        text: "Employees receive 25 days.\n",
        citations: [
          {
            sourceIndex: 0,
            sectionIndex: 0,
            endSectionIndex: 1,
            quote: "Employees receive 25 days.",
          },
        ],
      },
      { type: "text", text: "\n", citations: [] },
      {
        type: "text",
        text: "SSO is on.\n",
        citations: [
          {
            sourceIndex: 1,
            sectionIndex: 0,
            endSectionIndex: 1,
            quote: "SSO is on.",
          },
        ],
      },
    ]);
  });

  it("drops malformed, invented and out-of-range lines instead of passing them on uncited", async () => {
    const chunks = [
      [
        "not json at all",
        line("Employees receive 40 days.", [
          { id: 1, quote: "Employees receive 40 days." },
        ]),
        line("Employees receive 25 days.", [
          { id: 9, quote: "Employees receive 25 days." },
        ]),
        line("Heading"),
      ].join("\n") + "\n",
    ];
    const events = await collect(make({ chunks }));

    expect(events.filter((e) => e.type === "text")).toEqual([
      { type: "text", text: "Heading\n", citations: [] },
    ]);
  });

  it("buffers SSE events split mid-line across transport chunks", async () => {
    const [event] = sse([textChunk(`${line("Heading")}\n`)]);
    const pieces = [event.slice(0, 10), event.slice(10, 31), event.slice(31)];
    const events = await collect(
      createGoogleProvider("gemini-3.8-flash", {
        apiKey: KEY,
        fetch: fakeFetch(pieces),
      })
    );

    expect(events[0]).toEqual({
      type: "text",
      text: "Heading\n",
      citations: [],
    });
  });

  it("counts thought tokens as output and maps STOP to stop", async () => {
    const pieces = sse([
      textChunk(`${line("Heading")}\n`),
      {
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 30,
        },
      },
    ]);
    const events = await collect(
      createGoogleProvider("gemini-3.8-flash", {
        apiKey: KEY,
        fetch: fakeFetch(pieces),
      })
    );

    expect(events[events.length - 1]).toEqual({
      type: "end",
      finishReason: "stop",
      refused: false,
      usage: { inputTokens: 100, outputTokens: 50 },
    });
  });

  it("reports null usage when only a non-final chunk carried it", async () => {
    const pieces = sse([
      {
        ...textChunk(`${line("Heading")}\n`),
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 2 },
      },
      { candidates: [{ finishReason: "MAX_TOKENS" }] },
    ]);
    const progress = { inputTokens: null, outputChars: 0 };
    const events = await collect(
      createGoogleProvider("gemini-3.8-flash", {
        apiKey: KEY,
        fetch: fakeFetch(pieces),
      }),
      request({ progress })
    );

    expect(events[events.length - 1]).toEqual({
      type: "end",
      finishReason: "other",
      refused: false,
      usage: null,
    });
    expect(progress.inputTokens).toBe(100);
    expect(progress.outputChars).toBeGreaterThan(0);
  });

  it("reports a blocked prompt or a safety stop as refused", async () => {
    const blocked = await collect(
      createGoogleProvider("gemini-3.8-flash", {
        apiKey: KEY,
        fetch: fakeFetch(sse([{ promptFeedback: { blockReason: "SAFETY" } }])),
      })
    );
    const safety = await collect(
      createGoogleProvider("gemini-3.8-flash", {
        apiKey: KEY,
        fetch: fakeFetch(sse([{ candidates: [{ finishReason: "SAFETY" }] }])),
      })
    );

    expect(blocked[blocked.length - 1]).toMatchObject({ refused: true });
    expect(safety[safety.length - 1]).toMatchObject({ refused: true });
  });

  it("throws a classified error from an error response, without the vendor message", async () => {
    const provider = createGoogleProvider("gemini-3.8-flash", {
      apiKey: KEY,
      fetch: fakeFetch([JSON.stringify(billingBody)], [], undefined, 402),
    });
    const error = await collect(provider).catch((e: Error) => e);

    expect(error).toBeInstanceOf(GeminiError);
    expect(provider.classify(error as Error)).toBe("billing");
    expect((error as Error).message).not.toContain("Prepay");
  });

  it("throws on an error event inside the SSE stream", async () => {
    const provider = createGoogleProvider("gemini-3.8-flash", {
      apiKey: KEY,
      fetch: fakeFetch(
        sse([
          {
            error: {
              code: 503,
              message: "The model is overloaded.",
              status: "UNAVAILABLE",
            },
          },
        ])
      ),
    });
    const error = await collect(provider).catch((e: Error) => e);

    expect(provider.classify(error as Error)).toBe("overloaded");
  });

  it("stops yielding buffered lines once the signal aborts", async () => {
    const controller = new AbortController();
    const chunks = [`${line("One")}\n${line("Two")}\n${line("Three")}\n`];
    const seen: ProviderStreamEvent[] = [];
    await expect(async () => {
      for await (const event of make({ chunks }).stream(
        request({ signal: controller.signal })
      )) {
        seen.push(event);
        controller.abort();
      }
    }).rejects.toThrow();

    expect(seen).toHaveLength(1);
  });

  it("fails closed with an auth error and no network call when the key is missing", async () => {
    const calls: Call[] = [];
    const provider = createGoogleProvider("gemini-3.8-flash", {
      apiKey: undefined,
      fetch: fakeFetch([], calls),
    });
    const error = await collect(provider).catch((e: Error) => e);

    expect(error).toBeInstanceOf(GeminiError);
    expect(provider.classify(error as Error)).toBe("auth");
    expect(calls).toHaveLength(0);
  });
});

describe("classifyGoogleError", () => {
  const err = (
    status: number,
    apiStatus: string,
    message = "",
    reason?: string
  ) =>
    GeminiError.fromBody(status, {
      error: {
        code: status,
        message,
        status: apiStatus,
        ...(reason
          ? {
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  reason,
                },
              ],
            }
          : {}),
      },
    });

  it.each([
    ["402 prepay credits depleted", err(402, "RESOURCE_EXHAUSTED"), "billing"],
    [
      "429 RESOURCE_EXHAUSTED (rate or spend cap; not distinguishable)",
      err(
        429,
        "RESOURCE_EXHAUSTED",
        "Resource has been exhausted (e.g. check quota)."
      ),
      "billing",
    ],
    [
      "429 spend cap",
      err(
        429,
        "RESOURCE_EXHAUSTED",
        "Your project has exceeded its monthly spending cap."
      ),
      "billing",
    ],
    [
      "400 FAILED_PRECONDITION free tier unavailable",
      err(
        400,
        "FAILED_PRECONDITION",
        "Gemini API free tier is not available in your country. Please enable billing on your project in Google AI Studio."
      ),
      "billing",
    ],
    [
      "400 FAILED_PRECONDITION other",
      err(400, "FAILED_PRECONDITION", "Model is not ready."),
      "bad_request",
    ],
    [
      "400 API_KEY_INVALID",
      err(400, "INVALID_ARGUMENT", "API key not valid.", "API_KEY_INVALID"),
      "auth",
    ],
    ["401 UNAUTHENTICATED", err(401, "UNAUTHENTICATED"), "auth"],
    ["403 PERMISSION_DENIED", err(403, "PERMISSION_DENIED"), "auth"],
    ["500 INTERNAL", err(500, "INTERNAL"), "overloaded"],
    ["503 UNAVAILABLE", err(503, "UNAVAILABLE"), "overloaded"],
    ["504 DEADLINE_EXCEEDED", err(504, "DEADLINE_EXCEEDED"), "overloaded"],
    [
      "400 INVALID_ARGUMENT",
      err(400, "INVALID_ARGUMENT", "Bad field."),
      "bad_request",
    ],
    ["404 NOT_FOUND", err(404, "NOT_FOUND"), "bad_request"],
  ])("%s", (_label, error, kind) => {
    expect(classifyGoogleError(error)).toBe(kind);
  });

  it("classifies connection failures as network and anything else as other", () => {
    expect(classifyGoogleError(new TypeError("fetch failed"))).toBe("network");
    expect(
      classifyGoogleError(
        Object.assign(new Error("reset"), { code: "ECONNRESET" })
      )
    ).toBe("network");
    expect(classifyGoogleError(new Error("boom"))).toBe("other");
  });
});
