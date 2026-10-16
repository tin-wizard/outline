import { act } from "react";
import type { AskEvent } from "~/utils/streamFetch";
import { streamFetch } from "~/utils/streamFetch";

// Test helper; the test file must vi.mock("~/utils/streamFetch").
const mocked = vi.mocked(streamFetch);

/** A stream the test feeds by hand; ends when `end` is called or the signal aborts. */
export function controlled() {
  const queue: AskEvent[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let signal: AbortSignal | undefined;
  mocked.mockImplementationOnce(async function* (_path, _body, options) {
    signal = options?.signal;
    signal?.addEventListener("abort", () => wake?.());
    while (true) {
      if (signal?.aborted) {
        return;
      }
      const next = queue.shift();
      if (next) {
        yield next;
      } else if (ended) {
        return;
      } else {
        await new Promise<void>((resolve) => (wake = resolve));
      }
    }
  });
  return {
    push: async (...events: AskEvent[]) => {
      queue.push(...events);
      wake?.();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    end: async () => {
      ended = true;
      wake?.();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    get signal() {
      return signal;
    },
  };
}

export const done = (conversationId: string | null): AskEvent => ({
  event: "done",
  data: {
    conversationId,
    usage: { inputTokens: 1, outputTokens: 1 },
    timings: { retrievalMs: 1, totalMs: 2 },
  },
});

export const block = (index: number): AskEvent => ({
  event: "block",
  data: { index, kind: "paragraph", markdown: `b${index}`, citations: [] },
});
