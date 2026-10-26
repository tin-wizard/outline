import type { PdfPageSize } from "../types";

/** Regions where US Letter is the standard paper size. */
const letterRegions = new Set([
  "US",
  "CA",
  "MX",
  "PH",
  "CO",
  "VE",
  "CL",
  "CR",
  "GT",
  "PA",
  "DO",
  "SV",
  "HN",
  "NI",
  "PR",
]);

/**
 * Returns the paper size most people in a locale print on, which is US Letter
 * in North America and parts of Latin America and A4 everywhere else.
 *
 * @param locale a BCP 47 or POSIX locale such as "en-US" or "de_DE".
 * @returns the default paper size for the locale.
 */
export function defaultPageSize(locale: string | undefined): PdfPageSize {
  const region = locale?.split(/[-_]/)[1]?.toUpperCase();
  return region && letterRegions.has(region) ? "Letter" : "A4";
}
