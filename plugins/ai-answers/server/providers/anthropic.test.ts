import type { AnswerClient } from "./anthropic";
import { createAnthropicStreamingProvider } from "./anthropic";

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
