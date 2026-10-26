import { unicodeCLDRtoBCP47 } from "@shared/utils/date";

/**
 * Formats the day a conversation started for the "Resumed · started …"
 * divider, e.g. "Fri, Oct 16".
 *
 * @param iso an ISO timestamp; missing or invalid values yield undefined.
 * @param language the UI language, e.g. "en_US"; the browser default if unusable.
 * @returns the label, or undefined when there is no usable date.
 */
export function startedLabel(
  iso: string | null | undefined,
  language?: string
): string | undefined {
  const date = iso ? new Date(iso) : undefined;
  if (!date || Number.isNaN(date.getTime())) {
    return undefined;
  }
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
  };
  try {
    return new Intl.DateTimeFormat(
      language ? unicodeCLDRtoBCP47(language) : undefined,
      options
    ).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }
}
