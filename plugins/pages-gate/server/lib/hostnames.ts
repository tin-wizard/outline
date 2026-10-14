import { isIP } from "node:net";

/**
 * Domains owned by the operator. No custom hostname may equal one of these or
 * be a subdomain of one.
 */
export const RESERVED_HOST_SUFFIXES: readonly string[] = Object.freeze([
  "tin.info",
  "implexus.io",
  "implexusdata.com",
  "roomzz.net",
]);

/** Thrown when a custom hostname fails validation. */
export class InvalidHostnameError extends Error {
  /** Why the hostname was refused. */
  public reason: string;

  /**
   * @param reason why the hostname was refused.
   */
  constructor(reason: string) {
    super(`Invalid hostname: ${reason}`);
    this.name = "InvalidHostnameError";
    this.reason = reason;
  }
}

/**
 * Validates a custom hostname for a gated site. Input is lowercased but never
 * trimmed.
 *
 * @param input the candidate hostname.
 * @param reserved hosts that neither the hostname nor any parent may equal.
 * @returns the lowercase hostname.
 * @throws {InvalidHostnameError} when the hostname is invalid.
 */
export function validateHostname(
  input: unknown,
  reserved: readonly string[]
): string {
  if (typeof input !== "string") {
    throw new InvalidHostnameError("must be a string");
  }
  const hostname = input.toLowerCase();
  if (hostname.length === 0 || hostname.length > 253) {
    throw new InvalidHostnameError("must be 1 to 253 characters");
  }
  // Checked before the label rules, which a dotted quad would pass.
  if (isIP(hostname) !== 0 || isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) {
    throw new InvalidHostnameError("must not be an IP address");
  }
  const labels = hostname.split(".");
  for (const label of labels) {
    if (label.length > 63) {
      throw new InvalidHostnameError("labels must be at most 63 characters");
    }
    // Also catches empty labels, so a trailing dot, whitespace and "*".
    if (!LABEL_PATTERN.test(label)) {
      throw new InvalidHostnameError(
        "labels must be letters, digits and inner hyphens"
      );
    }
  }
  // No public TLD is numeric or hex, but WHATWG URL and inet_aton read such
  // hosts (127.1, 0x7f.1, 017.0.0.1) as IPv4 addresses.
  if (NUMERIC_LABEL_PATTERN.test(labels[labels.length - 1])) {
    throw new InvalidHostnameError("must not be an IP address");
  }
  if (labels.length < 2) {
    throw new InvalidHostnameError("must have at least two labels");
  }
  // A bare "localhost" already failed the two-label rule.
  if (SPECIAL_USE_TLDS.includes(labels[labels.length - 1])) {
    throw new InvalidHostnameError("must be a public domain");
  }
  for (const host of reserved) {
    const blocked = host.toLowerCase();
    if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
      throw new InvalidHostnameError("is reserved");
    }
  }
  return hostname;
}

const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const NUMERIC_LABEL_PATTERN = /^([0-9]+|0x[0-9a-f]*)$/;
const SPECIAL_USE_TLDS = ["localhost", "local", "internal", "test", "invalid"];
