import { vi } from "vitest";

const VARIABLES = [
  "PAGES_R2_ACCOUNT_ID",
  "PAGES_R2_ACCESS_KEY_ID",
  "PAGES_R2_SECRET_ACCESS_KEY",
  "PAGES_R2_BUCKET",
  "PAGES_PUBLIC_BASE_URL",
] as const;

/** Every key the tests touch, including the Docker-style `_FILE` secrets. */
const KEYS = VARIABLES.flatMap((name) => [name, `${name}_FILE`]);

async function loadEnv(set: readonly string[]) {
  for (const name of KEYS) {
    if (set.includes(name)) {
      process.env[name] = "value";
    } else {
      delete process.env[name];
    }
  }
  vi.resetModules();
  // Hermetic: the real loader merges a developer's .env back into
  // process.env on import, which would refill the keys deleted above.
  vi.doMock("@server/utils/environment", () => ({
    default: process.env,
    withFileSecrets: (env: Record<string, string | undefined>) => env,
  }));
  return (await import("./env")).default;
}

describe("PagesPluginEnvironment", () => {
  const original = { ...process.env };

  afterEach(() => {
    vi.doUnmock("@server/utils/environment");
    for (const name of KEYS) {
      if (original[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original[name];
      }
    }
  });

  it("is disabled when nothing is set", async () => {
    expect((await loadEnv([])).PAGES_ENABLED).toBe(false);
  });

  it.each(VARIABLES)("is disabled when only %s is missing", async (missing) => {
    const env = await loadEnv(VARIABLES.filter((name) => name !== missing));
    expect(env.PAGES_ENABLED).toBe(false);
  });

  it("is enabled when all five are set", async () => {
    expect((await loadEnv(VARIABLES)).PAGES_ENABLED).toBe(true);
  });
});
