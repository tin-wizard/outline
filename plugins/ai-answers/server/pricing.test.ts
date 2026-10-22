import { costMicroUsd } from "./pricing";

describe("costMicroUsd", () => {
  it("prices Sonnet 5.5 at $2 in / $10 out per million tokens", () => {
    expect(
      costMicroUsd("claude-sonnet-5-5", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      })
    ).toEqual(12_000_000);
    expect(
      costMicroUsd("claude-sonnet-5-5", {
        inputTokens: 1500,
        outputTokens: 200,
      })
    ).toEqual(5000);
  });

  it("prices Haiku and Opus 5.5", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(costMicroUsd("claude-haiku-5-5", usage)).toEqual(600_000);
    expect(costMicroUsd("claude-opus-5-5", usage)).toEqual(24_000_000);
  });

  it("prices Gemini 3.8 Flash at the standard $1.50 in / $7.50 out", () => {
    expect(
      costMicroUsd("gemini-3.8-flash", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      })
    ).toEqual(9_000_000);
  });

  it("rounds fractional micro-dollars up", () => {
    expect(
      costMicroUsd("claude-haiku-5-5", { inputTokens: 1, outputTokens: 0 })
    ).toEqual(1);
  });

  it("matches dated variants of a known model", () => {
    expect(
      costMicroUsd("claude-sonnet-5-5-20261001", {
        inputTokens: 1000,
        outputTokens: 0,
      })
    ).toEqual(2000);
  });

  it("prices an unknown model at the most expensive known price, never zero", () => {
    const usage = { inputTokens: 1000, outputTokens: 1000 };
    expect(costMicroUsd("mystery-model", usage)).toEqual(24_000);
    expect(
      costMicroUsd("", { inputTokens: 1, outputTokens: 1 })
    ).toBeGreaterThan(0);
  });
});
