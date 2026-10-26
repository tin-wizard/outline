import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import type { AnswerClient } from "./anthropic";
import {
  classifyAnthropicError,
  createAnthropicStreamingProvider,
} from "./anthropic";

const usage = {
  input_tokens: 10,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
};

function fakeClient() {
  const create = vi.fn(async (_body: object) =>
    (async function* () {
      yield { type: "message_start", message: { usage } };
      yield {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "Hello.", citations: [] },
      };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "citations_delta",
          citation: {
            type: "search_result_location",
            search_result_index: 0,
            start_block_index: 1,
            end_block_index: 2,
            cited_text: "Hello.",
          },
        },
      };
      yield { type: "content_block_stop", index: 0 };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { ...usage, output_tokens: 7 },
      };
    })()
  );
  // The fake implements only the part of the SDK the provider uses.
  return {
    create,
    client: { messages: { create } } as unknown as AnswerClient,
  };
}

const request = { question: "q", sources: [], history: [] };

describe("createAnthropicStreamingProvider", () => {
  it("streams text blocks with citations then an end event", async () => {
    const { client } = fakeClient();
    const provider = createAnthropicStreamingProvider(client, "m");
    const events = [];
    for await (const event of provider.stream(request)) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        type: "text",
        text: "Hello.",
        citations: [
          {
            sourceIndex: 0,
            sectionIndex: 1,
            endSectionIndex: 2,
            quote: "Hello.",
          },
        ],
      },
      {
        type: "end",
        finishReason: "stop",
        refused: false,
        usage: { inputTokens: 10, outputTokens: 7 },
      },
    ]);
  });

  it("passes the configured model to the client", async () => {
    const { client, create } = fakeClient();
    const provider = createAnthropicStreamingProvider(client, "custom-model");
    expect(provider.id).toBe("anthropic");
    await provider.stream(request).next();
    expect(create.mock.calls[0]?.[0]).toMatchObject({ model: "custom-model" });
  });
});

/** An SDK error as the client throws it for an HTTP error response. */
function httpError(
  status: number,
  type: string,
  message: string,
  details?: object
): Error {
  return APIError.generate(
    status,
    {
      type: "error",
      error: { type, message, ...(details ? { details } : {}) },
    },
    undefined,
    new Headers()
  );
}

/** An SDK error as the stream throws it for an SSE `error` event after a 200. */
function sseError(type: APIError["type"], message: string): Error {
  return new APIError(
    undefined,
    { type: "error", error: { type, message } },
    undefined,
    new Headers(),
    type
  );
}

describe("classifyAnthropicError", () => {
  it("classifies the production credit-balance 400 as billing", () => {
    const error = httpError(
      400,
      "invalid_request_error",
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."
    );
    expect(error.message).toBe(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}'
    );
    expect(classifyAnthropicError(error)).toBe("billing");
  });

  it("classifies 402, the spend-limit 429 and a usage-limit 400 as billing", () => {
    expect(
      classifyAnthropicError(
        httpError(402, "billing_error", "Payment required")
      )
    ).toBe("billing");
    expect(
      classifyAnthropicError(
        httpError(429, "rate_limit_error", "Monthly limit reached.", {
          error_code: "enforced_spend_limit_reached",
        })
      )
    ).toBe("billing");
    expect(
      classifyAnthropicError(
        httpError(
          400,
          "invalid_request_error",
          "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."
        )
      )
    ).toBe("billing");
  });

  it("classifies other 429s as rate_limit", () => {
    expect(
      classifyAnthropicError(
        httpError(
          429,
          "rate_limit_error",
          "Number of request tokens has exceeded your per-minute rate limit"
        )
      )
    ).toBe("rate_limit");
  });

  it("classifies 529, 5xx and an SSE overloaded_error as overloaded", () => {
    for (const status of [529, 500, 502, 503, 504]) {
      expect(
        classifyAnthropicError(
          httpError(status, "overloaded_error", "Overloaded")
        )
      ).toBe("overloaded");
    }
    expect(
      classifyAnthropicError(sseError("overloaded_error", "Overloaded"))
    ).toBe("overloaded");
  });

  it("classifies connection errors as network", () => {
    expect(
      classifyAnthropicError(
        new APIConnectionError({ cause: new TypeError("fetch failed") })
      )
    ).toBe("network");
    expect(
      classifyAnthropicError(
        Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })
      )
    ).toBe("network");
    expect(classifyAnthropicError(new TypeError("fetch failed"))).toBe(
      "network"
    );
  });

  it("classifies 401 and 403 as auth", () => {
    expect(
      classifyAnthropicError(
        httpError(401, "authentication_error", "invalid x-api-key")
      )
    ).toBe("auth");
    expect(
      classifyAnthropicError(
        httpError(
          403,
          "permission_error",
          "Your API key does not have permission"
        )
      )
    ).toBe("auth");
  });

  it("classifies other 4xx as bad_request", () => {
    for (const status of [400, 413, 422]) {
      expect(
        classifyAnthropicError(
          httpError(status, "invalid_request_error", "messages: field required")
        )
      ).toBe("bad_request");
    }
  });

  it("classifies a plain 400 invalid request as bad_request, not billing", () => {
    expect(
      classifyAnthropicError(
        httpError(400, "invalid_request_error", "max_tokens: Field required")
      )
    ).toBe("bad_request");
  });

  it("classifies anything else, including an abort, as other", () => {
    expect(classifyAnthropicError(new Error("boom"))).toBe("other");
    expect(classifyAnthropicError(new APIUserAbortError())).toBe("other");
  });

  it("is the adapter's classify", () => {
    const provider = createAnthropicStreamingProvider(fakeClient().client, "m");
    expect(provider.classify(httpError(402, "billing_error", "x"))).toBe(
      "billing"
    );
  });
});
