/**
 * Slugs that can never name a gated site, because they collide with other
 * objects or routes that share the bucket. Frozen so it cannot be changed at
 * runtime.
 */
export const RESERVED_SLUGS: readonly string[] = Object.freeze([
  "platform-architecture",
  "platform-onboarding",
  "implexus-platform",
  "robots.txt",
  "_headers",
]);

/** Thrown when a slug fails validation. */
export class InvalidSlugError extends Error {
  /** Why the slug was refused. */
  public reason: string;

  /**
   * @param reason why the slug was refused.
   */
  constructor(reason: string) {
    super(`Invalid slug: ${reason}`);
    this.name = "InvalidSlugError";
    this.reason = reason;
  }
}

/** Thrown when a page key fails validation. */
export class InvalidPageKeyError extends Error {
  /** Why the page key was refused. */
  public reason: string;

  /**
   * @param reason why the page key was refused.
   */
  constructor(reason: string) {
    super(`Invalid page key: ${reason}`);
    this.name = "InvalidPageKeyError";
    this.reason = reason;
  }
}

/** Thrown when an object key or prefix falls outside its site's prefix. */
export class KeyOutsideSiteError extends Error {
  /** Why the key or prefix was refused. */
  public reason: string;

  /**
   * @param reason why the key or prefix was refused.
   */
  constructor(reason: string) {
    super(`Key outside site: ${reason}`);
    this.name = "KeyOutsideSiteError";
    this.reason = reason;
  }
}

/**
 * Checks whether a value is an acceptable site slug. Input is never trimmed
 * or normalised.
 *
 * @param slug the candidate slug.
 * @returns true when the slug is valid.
 */
export function isValidSlug(slug: string): boolean {
  return slugProblem(slug) === undefined;
}

/**
 * Asserts that a value is an acceptable site slug.
 *
 * @param slug the candidate slug.
 * @throws {InvalidSlugError} when the slug is invalid.
 */
export function assertValidSlug(slug: string): void {
  const problem = slugProblem(slug);
  if (problem !== undefined) {
    throw new InvalidSlugError(problem);
  }
}

/**
 * Builds the object store prefix that holds every object of a site.
 *
 * @param slug the site slug.
 * @returns the prefix, always ending in "/".
 * @throws {InvalidSlugError} when the slug is invalid.
 */
export function sitePrefix(slug: string): string {
  assertValidSlug(slug);
  return `sites/${slug}/`;
}

/**
 * Checks whether a value is an acceptable page key, a relative path inside a
 * site.
 *
 * @param pageKey the candidate page key.
 * @returns true when the page key is valid.
 */
export function isValidPageKey(pageKey: string): boolean {
  return pageKeyProblem(pageKey) === undefined;
}

/**
 * Asserts that a value is an acceptable page key.
 *
 * @param pageKey the candidate page key.
 * @throws {InvalidPageKeyError} when the page key is invalid.
 */
export function assertValidPageKey(pageKey: string): void {
  const problem = pageKeyProblem(pageKey);
  if (problem !== undefined) {
    throw new InvalidPageKeyError(problem);
  }
}

/**
 * Builds the full object key for a page of a site.
 *
 * @param slug the site slug.
 * @param pageKey the page key inside the site.
 * @returns the object key.
 * @throws {InvalidSlugError} when the slug is invalid.
 * @throws {InvalidPageKeyError} when the page key is invalid.
 */
export function siteKey(slug: string, pageKey: string): string {
  const prefix = sitePrefix(slug);
  assertValidPageKey(pageKey);
  return prefix + pageKey;
}

/**
 * Guards a single object key before any put, get, head or delete: the key
 * must be the site prefix followed by a valid page key.
 *
 * @param slug the site slug.
 * @param key the full object key.
 * @throws {InvalidSlugError} when the slug is invalid.
 * @throws {KeyOutsideSiteError} when the key is not inside the site.
 */
export function assertKeyWithinSite(slug: string, key: string): void {
  const prefix = sitePrefix(slug);
  if (typeof key !== "string" || !key.startsWith(prefix)) {
    throw new KeyOutsideSiteError("key does not start with the site prefix");
  }
  const problem = pageKeyProblem(key.slice(prefix.length));
  if (problem !== undefined) {
    throw new KeyOutsideSiteError(problem);
  }
}

/**
 * Guards a prefix before a list or bulk delete: it must be exactly the site
 * prefix, or the site prefix plus a valid directory path ending in "/".
 * Passing exactly the site prefix covers the whole site, so a caller deleting
 * a sub-directory must append its own trailing "/" to that directory.
 *
 * @param slug the site slug.
 * @param prefix the object key prefix.
 * @throws {InvalidSlugError} when the slug is invalid.
 * @throws {KeyOutsideSiteError} when the prefix is not inside the site.
 */
export function assertPrefixWithinSite(slug: string, prefix: string): void {
  const root = sitePrefix(slug);
  if (prefix === root) {
    return;
  }
  if (
    typeof prefix !== "string" ||
    !prefix.startsWith(root) ||
    !prefix.endsWith("/")
  ) {
    throw new KeyOutsideSiteError(
      "prefix is not the site prefix or a directory inside it"
    );
  }
  const problem = pageKeyProblem(prefix.slice(root.length, -1));
  if (problem !== undefined) {
    throw new KeyOutsideSiteError(problem);
  }
}

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// "/" is only a separator; segments are checked separately below.
const PAGE_KEY_PATTERN = /^[a-z0-9._/-]+$/;

function slugProblem(slug: unknown): string | undefined {
  if (typeof slug !== "string") {
    return "must be a string";
  }
  if (slug.length < 3 || slug.length > 40) {
    return "must be 3 to 40 characters";
  }
  if (!SLUG_PATTERN.test(slug)) {
    return "must be lowercase letters and digits separated by single hyphens";
  }
  if (RESERVED_SLUGS.includes(slug)) {
    return "is reserved";
  }
  return undefined;
}

function pageKeyProblem(pageKey: unknown): string | undefined {
  if (typeof pageKey !== "string") {
    return "must be a string";
  }
  if (pageKey.length < 1 || pageKey.length > 512) {
    return "must be 1 to 512 characters";
  }
  if (!PAGE_KEY_PATTERN.test(pageKey)) {
    return "may only contain lowercase letters, digits, '.', '_', '-' and '/'";
  }
  // Empty segments catch leading, trailing and doubled "/"; a leading "."
  // catches ".", ".." and dotfiles.
  for (const segment of pageKey.split("/")) {
    if (segment === "") {
      return "must not have empty segments or a leading or trailing '/'";
    }
    if (segment.startsWith(".")) {
      return "segments must not start with '.'";
    }
  }
  return undefined;
}
