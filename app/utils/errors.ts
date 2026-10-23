import ExtendableError from "es6-error";

// Note: `name` is assigned explicitly on each error rather than inherited from
// the constructor name, which is mangled by the production build and would
// otherwise be reported as a single letter.

/** Facts about a failed API request; all optional. */
export interface ApiErrorDetails {
  /** The HTTP status of the failed request. */
  status?: number;
  /** The server's error id, e.g. "rate_limit_exceeded". */
  id?: string;
  /** Seconds to wait before retrying, from `Retry-After`. */
  retryAfter?: number;
  /** Structured data the server attached to the error. */
  data?: Record<string, unknown>;
}

/** Base of errors thrown for a failed API request. */
export class ApiError extends ExtendableError implements ApiErrorDetails {
  name = "ApiError";

  status?: number;

  id?: string;

  retryAfter?: number;

  data?: Record<string, unknown>;

  /**
   * Creates an error for a failed API request.
   *
   * @param message the message to show for the failure.
   * @param details facts about the failed request.
   */
  constructor(message?: string, details: ApiErrorDetails = {}) {
    super(message);
    this.status = details.status;
    this.id = details.id;
    this.retryAfter = details.retryAfter;
    this.data = details.data;
  }
}

/** Error thrown when the user is not authorized to perform a request. */
export class AuthorizationError extends ApiError {
  name = "AuthorizationError";
}

/** Error thrown when the server could not understand the request. */
export class BadRequestError extends ApiError {
  name = "BadRequestError";
}

/** Error thrown when a network-level failure prevents a request. */
export class NetworkError extends ExtendableError {
  name = "NetworkError";
}

/** Error thrown when the requested resource could not be found. */
export class NotFoundError extends ApiError {
  name = "NotFoundError";
}

/** Error thrown when the request requires payment or an upgraded plan. */
export class PaymentRequiredError extends ApiError {
  name = "PaymentRequiredError";
}

/** Error thrown when a request is made while the client is offline. */
export class OfflineError extends ExtendableError {
  name = "OfflineError";
}

/** Error thrown when the service is temporarily unavailable. */
export class ServiceUnavailableError extends ApiError {
  name = "ServiceUnavailableError";
}

/** Error thrown when an upstream server returned an invalid response. */
export class BadGatewayError extends ApiError {
  name = "BadGatewayError";
}

/** Error thrown when the request was well-formed but could not be processed. */
export class UnprocessableEntityError extends ApiError {
  name = "UnprocessableEntityError";
}

/** Error thrown when the client has exceeded the allowed request rate. */
export class RateLimitExceededError extends ApiError {
  name = "RateLimitExceededError";
}

/** Error thrown when the client closed the connection before a response. */
export class ClientClosedRequestError extends ApiError {
  name = "ClientClosedRequestError";
}

/** Error thrown when a request fails for a generic reason. */
export class RequestError extends ApiError {
  name = "RequestError";
}

/** Error thrown when the client version is too old to use the API. */
export class UpdateRequiredError extends ApiError {
  name = "UpdateRequiredError";
}
