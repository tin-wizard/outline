import { unicodeCLDRtoBCP47 } from "@shared/utils/date";

/** A source not edited for this many days is flagged as possibly out of date. */
export const STALE_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a source was last updated more than `STALE_DAYS` ago.
 *
 * @param updatedAt ISO time of the last edit; missing or invalid is not stale.
 * @param now the current time in ms, injectable for tests.
 * @returns true when the source is stale.
 */
export function isStale(
  updatedAt: string | undefined,
  now: number = Date.now()
): boolean {
  const time = updatedAt ? Date.parse(updatedAt) : NaN;
  return !Number.isNaN(time) && now - time > STALE_DAYS * DAY_MS;
}

/**
 * Formats a timestamp in the user's locale, e.g. "Oct 14, 2026".
 *
 * @param iso an ISO timestamp; missing or invalid values yield undefined.
 * @param language the UI language, e.g. "en_US"; the browser default if unusable.
 * @param options `time` adds the time of day, `utc` formats in UTC (for limits
 * that reset at a UTC boundary) instead of the local zone.
 * @returns the label, or undefined when there is no usable date.
 */
export function formatWhen(
  iso: string | null | undefined,
  language?: string,
  options: { time?: boolean; utc?: boolean } = {}
): string | undefined {
  const date = iso ? new Date(iso) : undefined;
  if (!date || Number.isNaN(date.getTime())) {
    return undefined;
  }
  const format: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    ...(options.time ? { timeStyle: "short" } : {}),
    ...(options.utc ? { timeZone: "UTC" } : {}),
  };
  try {
    return new Intl.DateTimeFormat(
      language ? unicodeCLDRtoBCP47(language) : undefined,
      format
    ).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, format).format(date);
  }
}
