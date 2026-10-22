/** Per-provider aggregate over the `cases.json` runs of one eval. */
export interface ProviderEvalResult {
  /** The `id:model` evaluated. */
  provider: string;
  /** Number of case runs aggregated. */
  runs: number;
  /** Answerable runs that produced an answer, as a fraction of answerable runs. */
  answeredRate: number;
  /** Citations that are valid, as a fraction of all returned citations; 1 when there are none. */
  validCitationRate: number;
  /** Dropped statements per answered run. */
  droppedPerAnswer: number;
  /** Not-covered runs that abstained, as a fraction of not-covered runs; 1 when there are none. */
  notCoveredAbstainRate: number;
  /** Runs where a leak marker reached the answer, a citation or the model input. */
  leakCount: number;
  /** Median latency in milliseconds (reported only). */
  medianLatencyMs: number;
  /** Cost per answered run in micro-USD (reported only). */
  costPerAnswerMicroUsd: number;
  /** Runs that ended in an error. */
  errorCount: number;
}

/** The outcome of comparing a candidate with a baseline. */
export interface GateVerdict {
  pass: boolean;
  /** One entry per failed criterion, starting with the criterion name. */
  failures: string[];
}

/** One run as written by `live.test.ts`. */
export interface EvalRow {
  answerable?: boolean;
  answer?: string | null;
  citationCount?: number;
  invalidCitations?: string[];
  droppedSegments?: number;
  leaked?: string[];
  sentLeaks?: string[];
  latencyMs?: number;
  costMicroUsd?: number;
  error?: string;
}

/** Default for `maxDroppedDelta`; a judgement value, not derived from data. */
export const DEFAULT_MAX_DROPPED_DELTA: number;

/** Default for `minAnsweredRatio`; a judgement value, not derived from data. */
export const DEFAULT_MIN_ANSWERED_RATIO: number;

export function aggregateResults(
  provider: string,
  rows: EvalRow[]
): ProviderEvalResult;
export function passesGate(
  result: ProviderEvalResult,
  baseline: ProviderEvalResult,
  options?: { maxDroppedDelta?: number; minAnsweredRatio?: number }
): GateVerdict;
export function evalProviderSpec(
  argv: string[],
  environment: Record<string, string | undefined>
): { spec: string | undefined; error?: string };
export function requiredKeyVariable(providerId: string): string | undefined;
