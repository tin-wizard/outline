import type Router from "koa-router";
import type env from "./env";

async function registeredRoutes(apiKey: string | undefined) {
  vi.resetModules();
  vi.doMock("./env", async (importOriginal) => {
    const actual = await importOriginal<{ default: typeof env }>();
    return {
      default: Object.assign(
        Object.create(Object.getPrototypeOf(actual.default)),
        actual.default,
        { ANTHROPIC_API_KEY: apiKey }
      ),
    };
  });
  const { PluginManager: Fresh, Hook: FreshHook } =
    await import("@server/utils/PluginManager");
  const before = Fresh.getHooks(FreshHook.API).length;
  await import("./index");
  return Fresh.getHooks(FreshHook.API)
    .slice(before)
    .flatMap((hook) => (hook.value as Router).stack.map((layer) => layer.path));
}

describe("ai-answers plugin entry", () => {
  afterEach(() => {
    vi.doUnmock("./env");
  });

  it("keeps the conversation routes without an API key, so chats can be deleted", async () => {
    const paths = await registeredRoutes(undefined);
    expect(paths).toContain("aiConversations.delete");
    expect(paths).toContain("aiConversations.list");
    expect(paths).not.toContain("ai.ask");
  });

  it("registers ai.ask with an API key", async () => {
    const paths = await registeredRoutes("test-key");
    expect(paths).toContain("ai.ask");
    expect(paths).toContain("aiConversations.delete");
  });
});
