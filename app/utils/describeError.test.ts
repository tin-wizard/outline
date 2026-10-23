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
import { describeError } from "./describeError";

const t = (key: string, options?: Record<string, unknown>) =>
  key.replace(/{{(\w+)}}/g, (_, name: string) => String(options?.[name]));

const GENERIC = {
  title: "Something went wrong.",
  hint: "Try again. If it keeps happening, tell an admin.",
  retryable: true,
};
const SERVER = {
  title: "Something went wrong on our side.",
  hint: "Try again in a moment.",
  retryable: true,
};
const OFFLINE = {
  title: "You're offline.",
  hint: "Check your connection and try again.",
  retryable: true,
};

describe("describeError", () => {
  it("describes offline errors", () => {
    expect(describeError(t, new OfflineError("x"))).toEqual(OFFLINE);
    expect(describeError(t, new NetworkError("x"))).toEqual(OFFLINE);
  });

  it.each([
    "Failed to fetch",
    "Load failed",
    "NetworkError when attempting to fetch resource.",
  ])("treats TypeError(%s) as offline", (message) => {
    expect(describeError(t, new TypeError(message))).toEqual(OFFLINE);
  });

  it("treats navigator.onLine === false as offline", () => {
    const spy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      expect(describeError(t, new Error("anything"))).toEqual(OFFLINE);
    } finally {
      spy.mockRestore();
    }
  });

  it("describes an expired session", () => {
    expect(
      describeError(t, new AuthorizationError("x", { status: 401 }))
    ).toEqual({
      title: "Your session has expired.",
      hint: "Sign in again.",
      retryable: false,
    });
  });

  it("describes other authorization errors", () => {
    const expected = {
      title: "You don't have permission to do that.",
      hint: "Ask an admin for access.",
      retryable: false,
    };
    expect(
      describeError(t, new AuthorizationError("x", { status: 403 }))
    ).toEqual(expected);
    expect(describeError(t, new AuthorizationError("x"))).toEqual(expected);
  });

  it("describes not found", () => {
    expect(describeError(t, new NotFoundError("x"))).toEqual({
      title: "That couldn't be found.",
      hint: "It may have been deleted or moved.",
      retryable: false,
    });
  });

  it("describes rate limiting with seconds", () => {
    expect(
      describeError(t, new RateLimitExceededError("x", { retryAfter: 30 }))
    ).toEqual({
      title: "Too many requests.",
      hint: "Try again in 30 seconds.",
      retryable: true,
    });
  });

  it.each([undefined, 0, NaN, -1, 99999, 1.5, 3601])(
    "falls back to 'a moment' for retryAfter %s",
    (retryAfter) => {
      expect(
        describeError(t, new RateLimitExceededError("x", { retryAfter }))
      ).toEqual({
        title: "Too many requests.",
        hint: "Try again in a moment.",
        retryable: true,
      });
    }
  );

  it("accepts the 3600 second boundary", () => {
    expect(
      describeError(t, new RateLimitExceededError("x", { retryAfter: 3600 }))
        .hint
    ).toBe("Try again in 3600 seconds.");
  });

  it("describes a conflict", () => {
    expect(describeError(t, new RequestError("x", { status: 409 }))).toEqual({
      title: "This changed since you opened it.",
      hint: "Reload and try again.",
      retryable: true,
    });
  });

  it("describes a too-large payload", () => {
    expect(describeError(t, new RequestError("x", { status: 413 }))).toEqual({
      title: "That file is too large.",
      retryable: false,
    });
  });

  it("describes payment required, preferring the server message", () => {
    expect(describeError(t, new PaymentRequiredError("Upgrade now"))).toEqual({
      title: "Upgrade now",
      retryable: false,
    });
    expect(describeError(t, new PaymentRequiredError(""))).toEqual({
      title: "This isn't available on your plan.",
      retryable: false,
    });
  });

  it("describes invalid requests, preferring the server message", () => {
    expect(describeError(t, new BadRequestError("Title is required"))).toEqual({
      title: "Title is required",
      retryable: false,
    });
    expect(describeError(t, new UnprocessableEntityError("Bad slug"))).toEqual({
      title: "Bad slug",
      retryable: false,
    });
    expect(describeError(t, new BadRequestError())).toEqual({
      title: "That request wasn't valid.",
      retryable: false,
    });
    expect(describeError(t, new UnprocessableEntityError("   "))).toEqual({
      title: "That request wasn't valid.",
      retryable: false,
    });
  });

  it("describes an outdated client", () => {
    expect(describeError(t, new UpdateRequiredError("x"))).toEqual({
      title: "A newer version of the app is needed.",
      hint: "Reload the page.",
      retryable: true,
    });
  });

  it("describes cancelled requests", () => {
    const expected = { title: "The request was cancelled.", retryable: true };
    expect(describeError(t, new ClientClosedRequestError("x"))).toEqual(
      expected
    );
    expect(describeError(t, new DOMException("aborted", "AbortError"))).toEqual(
      expected
    );
    const named = new Error("stop");
    named.name = "AbortError";
    expect(describeError(t, named)).toEqual(expected);
  });

  it("describes server faults without leaking the message", () => {
    const faults = [
      new RequestError("secret upstream text"),
      new ServiceUnavailableError("secret upstream text"),
      new BadGatewayError("secret upstream text"),
      new ApiError("secret upstream text", { status: 500 }),
      new ApiError("secret upstream text", { status: 504 }),
      new NotFoundError("secret upstream text", { status: 503 }),
    ];
    for (const fault of faults) {
      const result = describeError(t, fault);
      expect(result).toEqual(SERVER);
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });

  it("does not leak the message of unknown errors", () => {
    const result = describeError(t, new Error("secret"));
    expect(result).toEqual(GENERIC);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("returns generic copy for non-error values without throwing", () => {
    for (const value of [null, undefined, "boom", 42, {}, { message: "x" }]) {
      expect(describeError(t, value)).toEqual(GENERIC);
    }
  });

  it("never throws, even for hostile values", () => {
    const hostile = {
      get status(): number {
        throw new Error("nope");
      },
      get name(): string {
        throw new Error("nope");
      },
    };
    expect(() => describeError(t, hostile)).not.toThrow();
    expect(describeError(t, hostile)).toEqual(GENERIC);
  });
});
