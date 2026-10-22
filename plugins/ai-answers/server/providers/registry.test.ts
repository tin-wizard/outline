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

  it("accepts google entries", () => {
    expect(
      parseProviderSpec(
        "anthropic:claude-sonnet-5-5,google:gemini-3.8-flash",
        "m"
      )
    ).toEqual([
      { id: "anthropic", model: "claude-sonnet-5-5" },
      { id: "google", model: "gemini-3.8-flash" },
    ]);
  });

  it("returns nothing for an empty or all-unknown spec", () => {
    expect(parseProviderSpec("", "m")).toEqual([]);
    expect(parseProviderSpec("nope:x", "m")).toEqual([]);
  });
});

describe("getProviders", () => {
  const original = env.AI_ANSWERS_PROVIDERS;
  const originalKey = env.GEMINI_API_KEY;

  afterEach(() => {
    env.AI_ANSWERS_PROVIDERS = original;
    env.GEMINI_API_KEY = originalKey;
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

  it("builds a google provider only when named, failing closed as auth without a key", async () => {
    env.AI_ANSWERS_PROVIDERS = undefined;
    expect(getProviders().map(({ id }) => id)).toEqual(["anthropic"]);

    env.AI_ANSWERS_PROVIDERS = "google:gemini-3.8-flash";
    env.GEMINI_API_KEY = undefined;
    const [google] = getProviders();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const error = await google
      .stream({ question: "q", sources: [], history: [] })
      .next()
      .catch((e: Error) => e);

    expect(google.id).toBe("google");
    expect(error).toBeInstanceOf(Error);
    expect(google.classify(error as Error)).toBe("auth");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
