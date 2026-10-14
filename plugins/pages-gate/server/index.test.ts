async function registeredTasks(enabled: boolean) {
  vi.resetModules();
  vi.doMock("./env", () => ({ default: { PAGES_ENABLED: enabled } }));
  const { PluginManager: Fresh, Hook: FreshHook } =
    await import("@server/utils/PluginManager");
  const before = Fresh.getHooks(FreshHook.Task).length;
  await import("./index");
  return Fresh.getHooks(FreshHook.Task)
    .slice(before)
    .map((hook) => hook.value.name);
}

describe("pages-gate plugin entry", () => {
  afterEach(() => {
    vi.doUnmock("./env");
  });

  it("registers the rollup and cleanup tasks when enabled", async () => {
    expect(await registeredTasks(true)).toEqual([
      "RollupPagesInsightsTask",
      "CleanupPagesInsightsTask",
    ]);
  });

  it("registers nothing when disabled", async () => {
    expect(await registeredTasks(false)).toEqual([]);
  });
});
