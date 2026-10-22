import env from "../env";
import { getProviders, parseProviderSpec } from "./registry";

describe("parseProviderSpec", () => {
  it("defaults to anthropic with the default model", () => {
    expect(parseProviderSpec(undefined, "m")).toEqual([
      { id: "anthropic", model: "m" },
    ]);
  });

  it("parses a comma list in order", () => {
    expect(
      parseProviderSpec(
        "anthropic:claude-haiku-5-5, anthropic:claude-sonnet-5-5",
        "m"
      )
    ).toEqual([
      { id: "anthropic", model: "claude-haiku-5-5" },
      { id: "anthropic", model: "claude-sonnet-5-5" },
    ]);
  });

  it("drops unknown ids", () => {
    expect(parseProviderSpec("nope:x,anthropic:y", "m")).toEqual([
      { id: "anthropic", model: "y" },
    ]);
  });

  it("returns nothing for an empty or all-unknown spec", () => {
    expect(parseProviderSpec("", "m")).toEqual([]);
    expect(parseProviderSpec("nope:x", "m")).toEqual([]);
  });
});

describe("getProviders", () => {
  const original = env.AI_ANSWERS_PROVIDERS;

  afterEach(() => {
    env.AI_ANSWERS_PROVIDERS = original;
  });

  it("builds one anthropic provider with AI_ANSWERS_MODEL by default", () => {
    env.AI_ANSWERS_PROVIDERS = undefined;

    expect(getProviders().map(({ id, model }) => ({ id, model }))).toEqual([
      { id: "anthropic", model: env.AI_ANSWERS_MODEL },
    ]);
  });

  it("builds providers from AI_ANSWERS_PROVIDERS", () => {
    env.AI_ANSWERS_PROVIDERS =
      "anthropic:claude-haiku-5-5,anthropic:claude-sonnet-5-5";

    expect(getProviders().map(({ model }) => model)).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
    ]);
  });
});
