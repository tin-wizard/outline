import Logger from "@server/logging/Logger";
import { getClient } from "../anthropicClient";
import type { StreamingProvider } from "../contract";
import env from "../env";
import { createAnthropicStreamingProvider } from "./anthropic";
import { createGoogleProvider } from "./google";

/**
 * Parses a provider spec: a comma list of `id:model` in failover order.
 *
 * @param spec the spec, e.g. `AI_ANSWERS_PROVIDERS`; unset means Anthropic.
 * @param defaultModel the model used when the spec is unset.
 * @returns the known providers in order; unknown ids are dropped.
 */
export function parseProviderSpec(
  spec: string | undefined,
  defaultModel: string
): { id: string; model: string }[] {
  if (spec === undefined) {
    return [{ id: "anthropic", model: defaultModel }];
  }
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const separator = entry.indexOf(":");
      const id = entry.slice(0, separator).trim();
      const model = entry.slice(separator + 1).trim();
      if (separator < 0 || !Object.hasOwn(factories, id) || !model) {
        Logger.warn("AI_ANSWERS_PROVIDERS entry ignored", { entry });
        return [];
      }
      return [{ id, model }];
    });
}

/**
 * The configured streaming providers, in failover order.
 *
 * @returns the providers from `AI_ANSWERS_PROVIDERS`; empty when none is valid.
 */
export function getProviders(): StreamingProvider[] {
  return parseProviderSpec(env.AI_ANSWERS_PROVIDERS, env.AI_ANSWERS_MODEL).map(
    ({ id, model }) => factories[id](model)
  );
}

const factories: Record<string, (model: string) => StreamingProvider> = {
  anthropic: (model) => createAnthropicStreamingProvider(getClient(), model),
  // Off unless named in AI_ANSWERS_PROVIDERS; without GEMINI_API_KEY every call fails as auth.
  google: (model) =>
    createGoogleProvider(model, { apiKey: env.GEMINI_API_KEY }),
};
