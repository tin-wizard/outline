import Anthropic from "@anthropic-ai/sdk";
import { CLIENT_TIMEOUT_MS } from "./contract";
import env from "./env";

export { CLIENT_TIMEOUT_MS };

/**
 * No retries: a call is billed and metered exactly once, and a slot's TTL
 * always outlasts the call.
 */
export const CLIENT_MAX_RETRIES = 0;

let client: Anthropic | undefined;

/**
 * Returns the shared Anthropic client, creating it on first use.
 *
 * @returns the client, authenticated with `ANTHROPIC_API_KEY`.
 */
export function getClient(): Anthropic {
  client ??= new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    timeout: CLIENT_TIMEOUT_MS,
    maxRetries: CLIENT_MAX_RETRIES,
  });
  return client;
}
