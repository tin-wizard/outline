/** Mirrors the server's slug rules in plugins/pages-gate/server/lib/keys.ts. */
export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 40;

/** Slugs the server refuses because they collide with other bucket objects. */
export const RESERVED_SLUGS: readonly string[] = [
  "platform-architecture",
  "platform-onboarding",
  "implexus-platform",
  "robots.txt",
  "_headers",
];

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Why a slug is not acceptable. */
export type SlugProblem = "length" | "pattern" | "reserved";

/**
 * Checks a site address the same way the server does. The input is never
 * trimmed or normalised.
 *
 * @param slug the candidate address.
 * @returns the first problem found, or undefined when the slug is valid.
 */
export function slugProblem(slug: string): SlugProblem | undefined {
  if (slug.length < SLUG_MIN_LENGTH || slug.length > SLUG_MAX_LENGTH) {
    return "length";
  }
  if (!SLUG_PATTERN.test(slug)) {
    return "pattern";
  }
  if (RESERVED_SLUGS.includes(slug)) {
    return "reserved";
  }
  return undefined;
}
