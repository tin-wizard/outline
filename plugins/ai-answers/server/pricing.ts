import type { Usage } from "./contract";

/** Price in micro-USD per token (numerically equal to USD per million tokens). */
interface Price {
  input: number;
  output: number;
}

const PRICES: Record<string, Price> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  // Standard price from 2027-01-01 (ai.google.dev/gemini-api/docs/pricing);
  // the introductory $0.75/$3.75 to 2026-12-31 is deliberately not used.
  // Output includes thinking tokens.
  "gemini-3.8-flash": { input: 1.5, output: 7.5 },
};

/** Applied to any model not listed: the most expensive known price, never zero. */
const FALLBACK_PRICE: Price = Object.values(PRICES).reduce((max, p) => ({
  input: Math.max(max.input, p.input),
  output: Math.max(max.output, p.output),
}));

/**
 * Cost of one model call in integer micro-USD, rounded up.
 *
 * @param model the model id; dated variants match their base id.
 * @param usage the token counts.
 * @returns the cost in micro-USD; unknown models are priced at the most expensive known model.
 */
export function costMicroUsd(model: string, usage: Usage): number {
  const key = Object.keys(PRICES).find(
    (id) => model === id || model.startsWith(`${id}-`)
  );
  const price = key ? PRICES[key] : FALLBACK_PRICE;
  return Math.ceil(
    usage.inputTokens * price.input + usage.outputTokens * price.output
  );
}
