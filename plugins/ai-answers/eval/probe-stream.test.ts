import { spawnSync } from "node:child_process";
import path from "node:path";

const script = path.join(__dirname, "probe-stream.mjs");

/** Runs the probe with only the given variables; refusals exit before any request. */
function probe(vars: Record<string, string>) {
  return spawnSync(process.execPath, [script], {
    env: { PATH: process.env.PATH ?? "", ...vars },
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("probe-stream.mjs", () => {
  it("refuses to run without explicit variables", () => {
    const result = probe({});
    expect(result.status).toEqual(1);
    expect(result.stderr).toContain("Refusing to run");
  });

  it("refuses a URL with credentials and never prints the key", () => {
    const key = "ol_api_" + "P".repeat(20);
    const result = probe({
      AI_PROBE_BASE_URL: "https://user:pass@example.invalid",
      AI_PROBE_API_KEY: key,
    });
    expect(result.status).toEqual(1);
    expect(result.stderr).toContain("without credentials");
    expect(result.stdout + result.stderr).not.toContain(key);
  });
});
