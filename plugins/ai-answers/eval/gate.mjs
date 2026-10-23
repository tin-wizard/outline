// Pure helpers for the per-provider eval gate. Plain JS so `run.mjs` can use
// them without a TypeScript loader; typed by gate.d.mts and re-exported from score.ts.

/**
 * Default allowed increase in dropped statements per answer over the baseline.
 * An explicit judgement value, not derived from data: tune it from baseline runs.
 */
export const DEFAULT_MAX_DROPPED_DELTA = 0.5;

/**
 * Default minimum answered rate, as a fraction of the baseline's. An explicit
 * judgement value, not derived from data: the owner has set no threshold.
 */
export const DEFAULT_MIN_ANSWERED_RATIO = 0.5;

const EPSILON = 1e-9;

/** The environment variable holding each known provider's API key. */
const KEY_VARIABLES = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
};

const ratio = (n, d, empty) => (d ? n / d : empty);

/**
 * Aggregates the runs of one provider into the numbers the gate compares.
 * Errored runs count as not answered and not abstained.
 *
 * @param {string} provider the `id:model` evaluated.
 * @param {import("./gate.d.mts").EvalRow[]} rows the runs written by `live.test.ts`.
 * @returns {import("./gate.d.mts").ProviderEvalResult} the aggregate.
 */
export function aggregateResults(provider, rows) {
  const answerable = rows.filter((r) => r.answerable);
  const notCovered = rows.filter((r) => r.answerable === false);
  const answered = rows.filter((r) => !r.error && typeof r.answer === "string");
  const answeredAnswerable = answerable.filter(
    (r) => !r.error && typeof r.answer === "string"
  );
  const citations = answered.reduce((a, r) => a + (r.citationCount ?? 0), 0);
  const invalid = answered.reduce(
    (a, r) => a + (r.invalidCitations?.length ?? 0),
    0
  );
  const dropped = answered.reduce((a, r) => a + (r.droppedSegments ?? 0), 0);
  const cost = rows.reduce((a, r) => a + (r.costMicroUsd ?? 0), 0);
  const latencies = rows.map((r) => r.latencyMs ?? 0).sort((a, b) => a - b);
  const mid = Math.floor(latencies.length / 2);
  const median =
    latencies.length === 0
      ? 0
      : latencies.length % 2
        ? latencies[mid]
        : (latencies[mid - 1] + latencies[mid]) / 2;
  return {
    provider,
    runs: rows.length,
    answeredRate: ratio(answeredAnswerable.length, answerable.length, 0),
    validCitationRate: ratio(citations - invalid, citations, 1),
    droppedPerAnswer: ratio(dropped, answered.length, 0),
    notCoveredAbstainRate: ratio(
      notCovered.filter((r) => !r.error && r.answer === null).length,
      notCovered.length,
      1
    ),
    leakCount: rows.filter((r) => r.leaked?.length || r.sentLeaks?.length)
      .length,
    medianLatencyMs: median,
    costPerAnswerMicroUsd: ratio(cost, answered.length, 0),
    errorCount: rows.filter((r) => r.error).length,
  };
}

/**
 * Decides whether a candidate provider may serve traffic, by comparison with a
 * baseline run over the same cases. Latency and cost never fail the gate.
 *
 * @param {import("./gate.d.mts").ProviderEvalResult} result the candidate.
 * @param {import("./gate.d.mts").ProviderEvalResult} baseline the reference run.
 * @param {{ maxDroppedDelta?: number, minAnsweredRatio?: number }} [options] `maxDroppedDelta` is the allowed increase in dropped statements per answer; `minAnsweredRatio` the least answered rate as a fraction of the baseline's.
 * @returns {import("./gate.d.mts").GateVerdict} the verdict and each failed criterion.
 */
export function passesGate(result, baseline, options = {}) {
  const maxDroppedDelta = options.maxDroppedDelta ?? DEFAULT_MAX_DROPPED_DELTA;
  const minAnsweredRatio =
    options.minAnsweredRatio ?? DEFAULT_MIN_ANSWERED_RATIO;
  const failures = [];
  if (result.runs === 0) {
    failures.push("no runs to evaluate");
  }
  if (result.answeredRate === 0 && baseline.answeredRate > 0) {
    failures.push("no answerable case was answered");
  }
  if (
    result.answeredRate <
    baseline.answeredRate * minAnsweredRatio - EPSILON
  ) {
    failures.push(
      `answeredRate ${result.answeredRate} is below ${minAnsweredRatio * 100}% of the baseline ${baseline.answeredRate}`
    );
  }
  if (result.validCitationRate < baseline.validCitationRate - EPSILON) {
    failures.push(
      `validCitationRate ${result.validCitationRate} is below the baseline ${baseline.validCitationRate}`
    );
  }
  if (result.notCoveredAbstainRate < baseline.notCoveredAbstainRate - EPSILON) {
    failures.push(
      `notCoveredAbstainRate ${result.notCoveredAbstainRate} is below the baseline ${baseline.notCoveredAbstainRate}`
    );
  }
  if (result.leakCount > 0) {
    failures.push(`leakCount ${result.leakCount} must be 0`);
  }
  if (
    result.droppedPerAnswer >
    baseline.droppedPerAnswer + maxDroppedDelta + EPSILON
  ) {
    failures.push(
      `droppedPerAnswer ${result.droppedPerAnswer} exceeds the baseline ${baseline.droppedPerAnswer} by more than ${maxDroppedDelta}`
    );
  }
  return { pass: failures.length === 0, failures };
}

/**
 * Resolves which single `id:model` an eval run exercises. Precedence:
 * `--provider`, then `--model` (meaning `anthropic:<model>`), then
 * `AI_ANSWERS_PROVIDERS`; with none, the Anthropic default.
 *
 * @param {string[]} argv the command-line arguments.
 * @param {Record<string, string | undefined>} environment the environment.
 * @returns {{ spec: string | undefined, error?: string }} the spec, or an error message.
 */
export function evalProviderSpec(argv, environment) {
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i > -1 ? argv[i + 1] : undefined;
  };
  const provider = flag("provider");
  const model = flag("model");
  if (provider && model) {
    return {
      spec: undefined,
      error: "Use either --provider or --model, not both.",
    };
  }
  const spec =
    provider ??
    (model ? `anthropic:${model}` : undefined) ??
    environment.AI_ANSWERS_PROVIDERS?.trim();
  if (spec === undefined || spec === "") {
    return { spec: undefined };
  }
  const separator = spec.indexOf(":");
  const id = spec.slice(0, separator);
  if (separator < 1 || !spec.slice(separator + 1) || spec.includes(",")) {
    return {
      spec,
      error:
        "Provider must be a single <id>:<model>, e.g. google:gemini-3.8-flash.",
    };
  }
  if (!Object.hasOwn(KEY_VARIABLES, id)) {
    return {
      spec,
      error: `Unknown provider "${id}"; known: ${Object.keys(KEY_VARIABLES).join(", ")}.`,
    };
  }
  return { spec };
}

/**
 * The environment variable holding a provider's API key.
 *
 * @param {string} providerId the provider id, e.g. `google`.
 * @returns {string | undefined} the variable name; undefined for an unknown provider.
 */
export function requiredKeyVariable(providerId) {
  return Object.hasOwn(KEY_VARIABLES, providerId)
    ? KEY_VARIABLES[providerId]
    : undefined;
}
