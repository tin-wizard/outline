// Offline evaluation of grounded answers (plugins/ai-answers/eval/cases.json).
//
// Costs real money, so it is manual and never part of CI. It needs
// the API key of the provider under test (ANTHROPIC_API_KEY for anthropic,
// GEMINI_API_KEY for google) in the environment and a LOCAL Postgres and Redis (it seeds
// synthetic documents into the test database from .env.test). It refuses to run
// against any non-local DATABASE_URL or REDIS_URL. Each run leaves its synthetic
// teams and documents behind in that local .env.test database, like a test run.
//
// Usage, from the repo root:
//   ANTHROPIC_API_KEY=... node plugins/ai-answers/eval/run.mjs \
//     [--provider google:gemini-3.8-flash | --model claude-sonnet-5-5] [--runs 3] \
//     [--out plugins/ai-answers/eval/eval-results.json] \
//     [--baseline path/to/baseline-results.json] [--max-dropped-delta 0.5]
//
// --provider sets AI_ANSWERS_PROVIDERS for the run, so the real provider
// registry is exercised; --model means anthropic:<model>. With --baseline (an
// earlier results file) the report ends with the gate verdict, which sets the
// exit code. Latency and cost are reported and never fail the gate.
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_DROPPED_DELTA,
  aggregateResults,
  evalProviderSpec,
  passesGate,
  requiredKeyVariable,
} from "./gate.mjs";
import { isLocalUrl } from "./guard.mjs";

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
const selection = evalProviderSpec(process.argv, process.env);
if (selection.error) {
  fail(selection.error);
}
const providerId = selection.spec?.split(":")[0] ?? "anthropic";
const keyVariable = requiredKeyVariable(providerId);
if (!process.env[keyVariable]) {
  fail(`${keyVariable} is not set; the live eval of ${providerId} needs it.`);
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
if (!databaseUrl || !isLocalUrl(databaseUrl)) {
  fail("Refusing to run: DATABASE_URL must point at 127.0.0.1 or localhost.");
}
if (!redisUrl || !isLocalUrl(redisUrl)) {
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
if (selection.spec) {
  env.AI_ANSWERS_PROVIDERS = selection.spec;
}

const run = spawnSync(
  path.join(repo, "node_modules/.bin/vitest"),
  ["run", "--project", "server", "plugins/ai-answers/eval/live.test.ts"],
  { cwd: repo, env, stdio: "inherit" }
);
if (run.status !== 0 || !existsSync(out)) {
  fail("Eval run failed.");
}

const { provider, results } = JSON.parse(readFileSync(out, "utf8"));
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "-");
console.log(`\n== ${provider}`);
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

const aggregate = aggregateResults(provider, results);
const rate = (x) => `${(100 * x).toFixed(1)}%`;
console.log(
  `\n  per provider: answered ${rate(aggregate.answeredRate)} | valid citations ${rate(aggregate.validCitationRate)} | dropped/answer ${aggregate.droppedPerAnswer.toFixed(2)} | abstain when not covered ${rate(aggregate.notCoveredAbstainRate)} | leaks ${aggregate.leakCount} | median latency ${Math.round(aggregate.medianLatencyMs)} ms | cost/answer ${Math.round(aggregate.costPerAnswerMicroUsd)} micro-USD | errors ${aggregate.errorCount}`
);
console.log(`\nwrote ${out}`);

const baselinePath = arg("baseline");
if (baselinePath) {
  const base = JSON.parse(readFileSync(path.resolve(baselinePath), "utf8"));
  const baseline = aggregateResults(
    base.provider ?? base.model ?? "baseline",
    base.results
  );
  const maxDroppedDelta = Number(
    arg("max-dropped-delta", String(DEFAULT_MAX_DROPPED_DELTA))
  );
  const verdict = passesGate(aggregate, baseline, { maxDroppedDelta });
  console.log(
    `\ngate vs ${baseline.provider} (maxDroppedDelta ${maxDroppedDelta}): ${verdict.pass ? "PASS" : "FAIL"}`
  );
  for (const failure of verdict.failures) {
    console.log(`  - ${failure}`);
  }
  process.exit(verdict.pass ? 0 : 1);
}
