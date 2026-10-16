import { getTestServer } from "@server/test/support";
import {
  buildOAuthUser,
  callMcpTool,
  mcpHeaders,
  mcpRequest,
  parseMcpResponse,
} from "@server/test/McpHelper";

// Registered at load, before the app is built.
const hookCalls = await vi.hoisted(async () => {
  const { PluginManager, Hook } = await import("@server/utils/PluginManager");
  const calls: { scopes: string[] }[] = [];
  PluginManager.add({
    type: Hook.MCPTools,
    value: (server, scopes) => {
      calls.push({ scopes });
      server.registerTool(
        "zz_plugin_test_tool",
        {
          title: "Plugin test tool",
          description: "Registered by a plugin hook.",
        },
        async () => ({
          content: [{ type: "text" as const, text: "from plugin" }],
        })
      );
    },
  });
  return calls;
});

const server = getTestServer();

describe("plugin MCP tools", () => {
  it("lists a tool registered through Hook.MCPTools and passes the token scopes", async () => {
    const { accessToken } = await buildOAuthUser();
    const { body } = mcpRequest("tools/list");
    const res = await server.post("/mcp/", {
      headers: mcpHeaders(accessToken),
      body,
    });
    const result = (await parseMcpResponse(res)) as {
      result: { tools: { name: string }[] };
    };
    const names = result.result.tools.map((t) => t.name);
    expect(names).toContain("zz_plugin_test_tool");
    expect(hookCalls.length).toBeGreaterThan(0);
    expect(hookCalls[hookCalls.length - 1].scopes.length).toBeGreaterThan(0);
  });

  it("can call the plugin tool", async () => {
    const { accessToken } = await buildOAuthUser();
    const result = await callMcpTool(
      server,
      accessToken,
      "zz_plugin_test_tool",
      {}
    );
    expect(JSON.stringify(result)).toContain("from plugin");
  });
});
