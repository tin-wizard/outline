import {
  ApiError,
  AuthorizationError,
  BadGatewayError,
  BadRequestError,
  ClientClosedRequestError,
  NetworkError,
  NotFoundError,
  OfflineError,
  PaymentRequiredError,
  RateLimitExceededError,
  RequestError,
  ServiceUnavailableError,
  UnprocessableEntityError,
  UpdateRequiredError,
} from "./errors";

/** A translate function, compatible with i18next's `t`. */
type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Plain-language copy for a caught error. */
export interface ErrorDescription {
  /** What happened. */
  title: string;
  /** What to do next. */
  hint?: string;
  /** Whether trying the same thing again may succeed. */
  retryable: boolean;
}

/** The longest `Retry-After`, in seconds, that is worth showing. */
const MAX_RETRY_AFTER = 3600;

const FETCH_FAILURES = [
  "Failed to fetch",
  "Load failed",
  "NetworkError when attempting to fetch resource.",
];

/**
 * Plain-language copy for a caught error. Never throws, and never includes the
 * message of a server fault or of an error that did not come from a 4xx API
 * response.
 *
 * @param t the translate function.
 * @param err the caught value, of any type.
 * @returns the title, optional hint and whether a retry may help.
 */
export function describeError(t: Translate, err: unknown): ErrorDescription {
  try {
    return describe(t, err);
  } catch {
    return generic(t);
  }
}

function describe(t: Translate, err: unknown): ErrorDescription {
  if (isOffline(err)) {
    return {
      title: t("You're offline."),
      hint: t("Check your connection and try again."),
      retryable: true,
    };
  }

  if (isAbort(err)) {
    return { title: t("The request was cancelled."), retryable: true };
  }

  if (!(err instanceof ApiError)) {
    return generic(t);
  }

  const status = typeof err.status === "number" ? err.status : undefined;

  if (status !== undefined && status >= 500) {
    return serverFault(t);
  }

  if (err instanceof AuthorizationError) {
    if (status === 401) {
      return {
        title: t("Your session has expired."),
        hint: t("Sign in again."),
        retryable: false,
      };
    }
    return {
      title: t("You don't have permission to do that."),
      hint: t("Ask an admin for access."),
      retryable: false,
    };
  }

  if (err instanceof NotFoundError) {
    return {
      title: t("That couldn't be found."),
      hint: t("It may have been deleted or moved."),
      retryable: false,
    };
  }

  if (err instanceof RateLimitExceededError) {
    const seconds = err.retryAfter;
    const showSeconds =
      typeof seconds === "number" &&
      Number.isInteger(seconds) &&
      seconds > 0 &&
      seconds <= MAX_RETRY_AFTER;
    return {
      title: t("Too many requests."),
      hint: showSeconds
        ? t("Try again in {{seconds}} seconds.", { seconds })
        : t("Try again in a moment."),
      retryable: true,
    };
  }

  if (status === 409) {
    return {
      title: t("This changed since you opened it."),
      hint: t("Reload and try again."),
      retryable: true,
    };
  }

  if (status === 413) {
    return { title: t("That file is too large."), retryable: false };
  }

  if (err instanceof PaymentRequiredError) {
    return {
      title: serverMessage(err) ?? t("This isn't available on your plan."),
      retryable: false,
    };
  }

  if (
    err instanceof BadRequestError ||
    err instanceof UnprocessableEntityError
  ) {
    return {
      title: serverMessage(err) ?? t("That request wasn't valid."),
      retryable: false,
    };
  }

  if (err instanceof UpdateRequiredError) {
    return {
      title: t("A newer version of the app is needed."),
      hint: t("Reload the page."),
      retryable: true,
    };
  }

  if (err instanceof ClientClosedRequestError) {
    return { title: t("The request was cancelled."), retryable: true };
  }

  if (
    err instanceof RequestError ||
    err instanceof ServiceUnavailableError ||
    err instanceof BadGatewayError
  ) {
    return serverFault(t);
  }

  return generic(t);
}

function serverFault(t: Translate): ErrorDescription {
  return {
    title: t("Something went wrong on our side."),
    hint: t("Try again in a moment."),
    retryable: true,
  };
}

function generic(t: Translate): ErrorDescription {
  return {
    title: t("Something went wrong."),
    hint: t("Try again. If it keeps happening, tell an admin."),
    retryable: true,
  };
}

function serverMessage(err: ApiError): string | undefined {
  const message = err.message;
  return typeof message === "string" && message.trim() ? message : undefined;
}

function isOffline(err: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return true;
  }
  if (err instanceof OfflineError || err instanceof NetworkError) {
    return true;
  }
  return err instanceof TypeError && FETCH_FAILURES.includes(err.message);
}

function isAbort(err: unknown): boolean {
  return (
    (err instanceof Error || err instanceof DOMException) &&
    err.name === "AbortError"
  );
}
