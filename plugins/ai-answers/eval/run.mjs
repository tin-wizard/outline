// Offline evaluation of grounded answers (plugins/ai-answers/eval/cases.json).
//
// Costs real money, so it is manual and never part of CI. It needs
// ANTHROPIC_API_KEY in the environment and a LOCAL Postgres and Redis (it seeds
// synthetic documents into the test database from .env.test). It refuses to run
// against any non-local DATABASE_URL or REDIS_URL.
//
// Usage, from the repo root:
//   ANTHROPIC_API_KEY=... node plugins/ai-answers/eval/run.mjs \
//     [--model claude-haiku-5-5] [--runs 3] [--out plugins/ai-answers/eval/eval-results.json]
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const isLocal = (url) => {
  try {
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      new URL(url).hostname
    );
  } catch {
    return false;
  }
};

if (!process.env.ANTHROPIC_API_KEY) {
  fail("ANTHROPIC_API_KEY is not set; the live eval needs it.");
}

// Pin both URLs explicitly: the shell or a dotenv file must not decide where this writes.
const dotenv = {};
const testEnv = path.join(repo, ".env.test");
if (existsSync(testEnv)) {
  for (const line of readFileSync(testEnv, "utf8").split("\n")) {
    const m = line.match(/^(DATABASE_URL|REDIS_URL)=(.*)$/);
    if (m) {
      dotenv[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}
const databaseUrl = process.env.DATABASE_URL ?? dotenv.DATABASE_URL;
const redisUrl = process.env.REDIS_URL ?? dotenv.REDIS_URL;
if (!databaseUrl || !isLocal(databaseUrl)) {
  fail("Refusing to run: DATABASE_URL must point at 127.0.0.1 or localhost.");
}
if (!redisUrl || !isLocal(redisUrl)) {
  fail("Refusing to run: REDIS_URL must point at 127.0.0.1 or localhost.");
}

const out = path.resolve(arg("out", path.join(here, "eval-results.json")));
const env = {
  ...process.env,
  NODE_ENV: "test",
  TZ: "UTC",
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  AI_ANSWERS_EVAL_LIVE: "1",
  AI_ANSWERS_EVAL_RUNS: arg("runs", "1"),
  AI_ANSWERS_EVAL_OUT: out,
};
if (arg("model")) {
  env.AI_ANSWERS_MODEL = arg("model");
}

const run = spawnSync(
  path.join(repo, "node_modules/.bin/vitest"),
  ["run", "--project", "server", "plugins/ai-answers/eval/live.test.ts"],
  { cwd: repo, env, stdio: "inherit" }
);
if (run.status !== 0 || !existsSync(out)) {
  fail("Eval run failed.");
}

const { model, results } = JSON.parse(readFileSync(out, "utf8"));
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "-");
console.log(`\n== ${model}`);
for (const stratum of new Set(results.map((r) => r.stratum))) {
  const rs = results.filter((r) => r.stratum === stratum);
  console.log(
    `  ${stratum.padEnd(14)} pass ${pct(rs.filter((r) => r.pass).length, rs.length)} (${rs.length} runs)`
  );
}
const leaks = results.filter(
  (r) => r.leaked?.length || r.sentLeaks?.length
).length;
const tokens = results.reduce(
  (a, r) => a + (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0),
  0
);
console.log(
  `  overall        pass ${pct(results.filter((r) => r.pass).length, results.length)} | leaks ${leaks} | errors ${results.filter((r) => r.error).length} | tokens ${tokens}`
);
for (const r of results.filter((x) => !x.pass).slice(0, 10)) {
  console.log(
    `    FAIL ${r.case} run ${r.run}: ${r.error ?? JSON.stringify({ missing: r.missing, forbidden: r.forbidden, uncited: r.uncitedTitles, ungrounded: r.ungroundedSentences, invalid: r.invalidCitations, leaked: r.leaked, sentLeaks: r.sentLeaks })}`
  );
}
console.log(`\nwrote ${out}`);
