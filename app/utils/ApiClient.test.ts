import { client } from "~/utils/ApiClient";
import Logger from "~/utils/Logger";
import {
  ApiError,
  AuthorizationError,
  BadGatewayError,
  BadRequestError,
  ClientClosedRequestError,
  NotFoundError,
  PaymentRequiredError,
  RateLimitExceededError,
  RequestError,
  ServiceUnavailableError,
  UnprocessableEntityError,
} from "~/utils/errors";

vi.unmock("~/utils/ApiClient");

const serverFault = "Something went wrong on our side. Try again in a moment.";
const rateLimitMoment = "Too many requests. Try again in a moment.";

interface MockResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

const fetchMock = vi.fn();

function respondWith({ status, body = "", headers = {} }: MockResponse) {
  fetchMock.mockResolvedValue(new Response(body, { status, headers }));
}

function respondWithJson(
  status: number,
  json: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  respondWith({
    status,
    body: JSON.stringify(json),
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function failure(): Promise<unknown> {
  try {
    await client.post("/documents.list", {}, { retry: false });
  } catch (err) {
    return err;
  }
  throw new Error("Expected the request to fail");
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(Logger, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ApiClient error mapping", () => {
  it("gives a 401 a session message", async () => {
    respondWithJson(401, { error: "authentication_required", message: "" });
    const err = await failure();
    expect(err).toBeInstanceOf(AuthorizationError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 401,
      id: "authentication_required",
      message: "Your session has expired. Sign in again.",
    });
  });

  it("maps a 500 to a plain server-fault message", async () => {
    respondWithJson(500, {
      error: "internal_error",
      message: "secret upstream text",
    });
    const err = await failure();
    expect(err).toBeInstanceOf(RequestError);
    expect(err).toMatchObject({
      status: 500,
      id: "internal_error",
      message: serverFault,
    });
  });

  it("keeps the path and gateway body out of a 502 message", async () => {
    respondWith({ status: 502, body: "<html>nginx upstream secret</html>" });
    const err = await failure();
    expect(err).toBeInstanceOf(BadGatewayError);
    expect(err).toMatchObject({ status: 502, message: serverFault });
    const message = err instanceof Error ? err.message : "";
    expect(message).not.toContain("documents.list");
    expect(message).not.toContain("nginx");
    expect(Logger.error).toHaveBeenCalledWith(
      "BadGatewayError",
      err,
      expect.objectContaining({
        responseText: "<html>nginx upstream secret</html>",
      }),
      ["BadGatewayError", "/documents.list"]
    );
  });

  it.each([
    [409, "This changed since you opened it. Reload and try again."],
    [413, "That file is too large."],
    [408, "That took too long. Try again."],
    [504, serverFault],
    [418, "Something went wrong (code 418). Try again."],
  ])("maps a %i to plain text", async (status, message) => {
    respondWithJson(status, { error: "some_error", message: "raw text" });
    const err = await failure();
    expect(err).toBeInstanceOf(RequestError);
    expect(err).toMatchObject({ status, id: "some_error", message });
  });

  it("uses the server-fault text for a 503 without a server message", async () => {
    respondWith({ status: 503 });
    const err = await failure();
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err).toMatchObject({ status: 503, message: serverFault });
  });

  it("keeps a 503 server message", async () => {
    respondWithJson(503, { message: "Down for maintenance" });
    const err = await failure();
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err).toMatchObject({ message: "Down for maintenance" });
  });

  it("keeps a 404 server message and the error data", async () => {
    respondWithJson(404, {
      error: "not_found",
      message: "Document not found",
      data: { documentId: "abc" },
    });
    const err = await failure();
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({
      status: 404,
      id: "not_found",
      message: "Document not found",
      data: { documentId: "abc" },
    });
  });

  it.each([
    [400, BadRequestError],
    [402, PaymentRequiredError],
    [403, AuthorizationError],
    [404, NotFoundError],
    [422, UnprocessableEntityError],
    [499, ClientClosedRequestError],
  ])("keeps the class and server message for a %i", async (status, Class) => {
    respondWithJson(status, { error: "reason", message: "Server says no" });
    const err = await failure();
    expect(err).toBeInstanceOf(Class);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status, message: "Server says no" });
  });

  it("reads Retry-After for a 429", async () => {
    respondWithJson(
      429,
      { error: "rate_limit_exceeded", message: "Rate limit exceeded" },
      { "Retry-After": "30" }
    );
    const err = await failure();
    expect(err).toBeInstanceOf(RateLimitExceededError);
    expect(err).toMatchObject({
      status: 429,
      id: "rate_limit_exceeded",
      retryAfter: 30,
      message: "Too many requests. Try again in 30 seconds.",
    });
  });

  it.each([undefined, "abc", "0", "-5", "999999"])(
    "falls back to a moment for a Retry-After of %s",
    async (retryAfter) => {
      respondWithJson(
        429,
        { error: "rate_limit_exceeded" },
        retryAfter === undefined ? {} : { "Retry-After": retryAfter }
      );
      const err = await failure();
      expect(err).toBeInstanceOf(RateLimitExceededError);
      expect(err).toMatchObject({ message: rateLimitMoment });
      const message = err instanceof Error ? err.message : "";
      expect(message).not.toMatch(/NaN|-\d/);
    }
  );

  it("never sets a negative or non-numeric retryAfter", async () => {
    for (const header of ["abc", "-5", "1.5"]) {
      respondWithJson(429, {}, { "Retry-After": header });
      const err = await failure();
      expect(err).toBeInstanceOf(ApiError);
      expect(err instanceof ApiError ? err.retryAfter : 0).toBeUndefined();
    }
  });

  it("maps a batched sub-request error the same way", async () => {
    respondWithJson(200, {
      data: [
        { ok: false, status: 500, error: "internal_error", message: "boom" },
        {
          ok: false,
          status: 429,
          error: "rate_limit_exceeded",
          message: "Rate limit exceeded",
        },
        { ok: false, status: 404, error: "not_found", message: "Gone" },
        { ok: false, status: 418, error: "teapot", message: "raw" },
      ],
    });
    const settle = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (err: unknown) => err
      );
    const [serverError, rateLimited, notFound, unmapped] = await Promise.all(
      client.batch(() => [
        settle(client.post("/documents.update", { id: "1" })),
        settle(client.post("/documents.update", { id: "2" })),
        settle(client.post("/documents.update", { id: "3" })),
        settle(client.post("/documents.update", { id: "4" })),
      ])
    );

    expect(serverError).toBeInstanceOf(RequestError);
    expect(serverError).toMatchObject({
      status: 500,
      id: "internal_error",
      message: serverFault,
    });
    expect(rateLimited).toBeInstanceOf(RateLimitExceededError);
    expect(rateLimited).toMatchObject({
      status: 429,
      message: rateLimitMoment,
    });
    expect(
      rateLimited instanceof ApiError ? rateLimited.retryAfter : 0
    ).toBeUndefined();
    expect(notFound).toBeInstanceOf(NotFoundError);
    expect(notFound).toMatchObject({ status: 404, message: "Gone" });
    expect(unmapped).toMatchObject({
      message: "Something went wrong (code 418). Try again.",
    });
  });
});
