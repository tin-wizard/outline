import { getClient } from "../anthropicClient";
import type { StreamingProvider } from "../contract";
import env from "../env";
import { createAnthropicStreamingProvider } from "./anthropic";

/**
 * The configured streaming providers, in failover order.
 *
 * @returns the providers; currently only Anthropic.
 */
export function getProviders(): StreamingProvider[] {
  return [createAnthropicStreamingProvider(getClient(), env.AI_ANSWERS_MODEL)];
}
