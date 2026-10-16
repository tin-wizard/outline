import Anthropic from "@anthropic-ai/sdk";
import env from "./env";

/** Per-request timeout of the Anthropic client. */
export const CLIENT_TIMEOUT_MS = 30_000;

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
