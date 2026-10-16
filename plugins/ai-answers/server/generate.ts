import {
  createAnthropicProvider,
  type AnswerClient,
} from "./providers/anthropic";
import { ZERO_USAGE, type Usage } from "./contract";
import type { AnswerSource } from "./retrieve";
import { verifyAnswer, type AnswerResult, type VerifiedAnswer } from "./verify";

export type { AnswerClient } from "./providers/anthropic";
export type { AnswerCitation, AnswerResult } from "./verify";

/** A verified answer plus the token usage of the model call that produced it. */
export interface AnswerOutcome extends VerifiedAnswer {
  /** Zero when no model call was made; null when the provider reported none. */
  usage: Usage | null;
}

/**
 * Asks Claude to answer a question from the given sources, reporting token
 * usage for metering. The answer is returned only when a citation backs it.
 *
 * @param client the Anthropic client.
 * @param question the user's question.
 * @param sources the retrieved sources, in the order they are sent.
 * @param signal aborts the model call; the returned promise then rejects.
 * @returns the answer, its citations and token usage; `answer: null` when none was found.
 */
export async function generateAnswerWithUsage(
  client: AnswerClient,
  question: string,
  sources: AnswerSource[],
  signal?: AbortSignal
): Promise<AnswerOutcome> {
  if (sources.length === 0) {
    return {
      answer: null,
      citations: [],
      droppedSegments: 0,
      abstained: false,
      usage: ZERO_USAGE,
    };
  }
  const result = await createAnthropicProvider(client).generate({
    question,
    sources,
    signal,
  });
  return { ...verifyAnswer(result, sources), usage: result.usage };
}

/**
 * Asks Claude to answer a question from the given sources.
 * The answer is returned only when at least one citation backs it.
 *
 * @param client the Anthropic client.
 * @param question the user's question.
 * @param sources the retrieved sources, in the order they are sent.
 * @returns the answer and its citations, or `answer: null` when none was found.
 */
export async function generateAnswer(
  client: AnswerClient,
  question: string,
  sources: AnswerSource[]
): Promise<AnswerResult> {
  const { answer, citations } = await generateAnswerWithUsage(
    client,
    question,
    sources
  );
  return { answer, citations };
}
