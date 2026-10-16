import type Anthropic from "@anthropic-ai/sdk";
import {
  MAX_OUTPUT_TOKENS,
  SYSTEM_PROMPT,
  type AnswerProvider,
  type ProviderSegment,
} from "../contract";
import env from "../env";
import { redactSecrets } from "../redact";

/** The part of the SDK client this module needs; lets tests pass a fake. */
export interface AnswerClient {
  messages: { create: Anthropic["messages"]["create"] };
}

/**
 * Creates a provider backed by the Anthropic Messages API, sending sources as
 * `search_result` blocks with citations enabled.
 *
 * @param client the Anthropic client.
 * @returns a provider returning unverified segments and token usage.
 */
export function createAnthropicProvider(client: AnswerClient): AnswerProvider {
  return {
    async generate({ question, sources }) {
      const response = await client.messages.create({
        model: env.AI_ANSWERS_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              ...sources.map((s) => ({
                type: "search_result" as const,
                // Not document.url: it embeds a slug of the unredacted title.
                source: `/doc/${s.document.urlId}`,
                title: redactSecrets(s.document.title || "Untitled").text,
                content: s.sections.map((text) => ({
                  type: "text" as const,
                  text,
                })),
                citations: { enabled: true },
              })),
              // A pasted secret in the question must not reach the model either.
              { type: "text" as const, text: redactSecrets(question).text },
            ],
          },
        ],
      });

      const segments: ProviderSegment[] = [];
      for (const block of response.content) {
        if (block.type !== "text") {
          continue;
        }
        segments.push({
          text: block.text,
          citations: (block.citations ?? []).flatMap((c) =>
            c.type === "search_result_location"
              ? [
                  {
                    sourceIndex: c.search_result_index,
                    sectionIndex: c.start_block_index,
                    endSectionIndex: c.end_block_index,
                    quote: c.cited_text,
                  },
                ]
              : []
          ),
        });
      }
      return {
        finishReason: response.stop_reason === "end_turn" ? "stop" : "other",
        usage: response.usage
          ? {
              inputTokens: response.usage.input_tokens,
              outputTokens: response.usage.output_tokens,
            }
          : null,
        segments,
      };
    },
  };
}
