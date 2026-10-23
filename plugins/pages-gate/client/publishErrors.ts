/** A publish or rotate failure, reduced to what the dialogs act on. */
export type PublishFailure =
  | { kind: "access_code_required" }
  | { kind: "incorrect_code" }
  /** The stored sources could not be loaded, so the admin must choose again. */
  | { kind: "sources_missing" }
  /** A chosen source could not be loaded. */
  | { kind: "source_not_found" }
  /** The live site could not be read; only a rotation repairs it. */
  | { kind: "state_conflict" }
  /** A rotation was refused because the site has no live code to replace. */
  | { kind: "nothing_to_rotate" }
  | { kind: "rate_limited" }
  /**
   * Anything else. `offerRotate` is set when a republish that sent a code was
   * refused with an unrecognised 400, so a changed server message can never
   * hide the repair path.
   */
  | { kind: "message"; message: string; offerRotate?: boolean };

/** What the failed request was and what it carried. */
export interface PublishAttempt {
  /** The call that failed. */
  action: "publish" | "rotate";
  /** Whether the request carried explicit sources. */
  sentSources: boolean;
  /** Whether the request carried an access code. */
  sentCode: boolean;
}

/** Prefixes of the server messages; a drift test ties them to the server. */
export const ACCESS_CODE_REQUIRED = "The current access code is required";
export const INCORRECT_CODE = "The access code does not match";

/**
 * Maps an API error to a publish failure. The API client keeps the server's
 * reason only as the error class and message, so 400s are told apart by the
 * server's fixed message text.
 *
 * @param err the error thrown by the API client.
 * @param attempt what the failed request was and carried.
 * @returns the failure.
 */
export function classifyPublishFailure(
  err: unknown,
  attempt: PublishAttempt
): PublishFailure {
  const name = readString(err, "name");
  const message = readString(err, "message");

  if (name === "NotFoundError") {
    return {
      kind: attempt.sentSources ? "source_not_found" : "sources_missing",
    };
  }
  if (name === "RateLimitExceededError") {
    return { kind: "rate_limited" };
  }
  // The client reports unmapped statuses, such as 409, with a generic message,
  // dropping the reason. Only a rotation can be told "nothing to rotate";
  // a publish 409 means the live entry page could not be read.
  if (name === "RequestError" && readStatus(err) === 409) {
    return {
      kind:
        attempt.action === "rotate" ? "nothing_to_rotate" : "state_conflict",
    };
  }
  if (name === "BadRequestError") {
    if (message.startsWith(ACCESS_CODE_REQUIRED)) {
      return { kind: "access_code_required" };
    }
    if (message.startsWith(INCORRECT_CODE)) {
      return { kind: "incorrect_code" };
    }
  }
  return {
    kind: "message",
    message,
    ...(name === "BadRequestError" && attempt.sentCode
      ? { offerRotate: true }
      : {}),
  };
}

/**
 * Whether a publish warning says old files could not be cleaned up, which
 * leaves removed pages readable with the previous code.
 *
 * @param warning one warning from the publish response.
 * @returns true for the stale-page cleanup warnings.
 */
export function isStaleCleanupWarning(warning: string): boolean {
  return /remain in storage/i.test(warning);
}

function readStatus(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("status" in value)) {
    return undefined;
  }
  return typeof value.status === "number" ? value.status : undefined;
}

function readString(value: unknown, key: "name" | "message"): string {
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" ? found : "";
}

/**
 * Decides which create-dialog field a server validation message belongs to.
 *
 * @param message the server's validation message.
 * @returns the field, or "form" when it belongs to neither.
 */
export function createErrorField(
  message: string
): "slug" | "hostname" | "form" {
  if (/^(The address|This address)/.test(message)) {
    return "slug";
  }
  if (/^(The domain|This domain)/.test(message)) {
    return "hostname";
  }
  return "form";
}
