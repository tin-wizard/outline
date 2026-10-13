import Anthropic from "@anthropic-ai/sdk";
import env from "./env";

let client: Anthropic | undefined;

/**
 * Returns the shared Anthropic client, creating it on first use.
 *
 * @returns the client, authenticated with `ANTHROPIC_API_KEY`.
 */
export function getClient(): Anthropic {
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}
