/**
 * Number of previous UTC days recomputed on each rollup run, in addition to
 * the current one, so late events settle.
 */
export const RECOMPUTE_DAYS = 2;

/**
 * Number of whole weeks before the current UTC week that are recomputed.
 */
export const RECOMPUTE_PREVIOUS_WEEKS = 1;

/**
 * The oldest recomputed period starts at most this many days before the day of
 * the run: the previous week begins 7 days before the current Monday, which is
 * itself up to 6 days old. Days reach back only RECOMPUTE_DAYS.
 */
export const MAX_RECOMPUTE_AGE_DAYS = Math.max(
  RECOMPUTE_DAYS,
  7 * RECOMPUTE_PREVIOUS_WEEKS + 6
);

/**
 * Raw events must outlive every recomputed period, otherwise the rollup would
 * overwrite a good row from only the surviving remainder. Retention must exceed
 * the maximum age of any recomputed period.
 */
export const MIN_EVENT_RETENTION_DAYS = MAX_RECOMPUTE_AGE_DAYS + 1;
