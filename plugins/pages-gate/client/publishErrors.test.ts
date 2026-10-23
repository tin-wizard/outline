import {
  AccessCodeRequiredError,
  IncorrectCodeError,
  NoLivePageError,
  NothingToRotateError,
} from "../server/lib/publish";
import {
  ACCESS_CODE_REQUIRED,
  type PublishAttempt,
  INCORRECT_CODE,
  classifyPublishFailure,
  createErrorField,
  isStaleCleanupWarning,
} from "./publishErrors";

const err = (name: string, message: string, status?: number) => ({
  name,
  message,
  status,
});
const conflictMessage =
  "This changed since you opened it. Reload and try again.";
const publish: PublishAttempt = {
  action: "publish",
  sentSources: false,
  sentCode: false,
};
const withCode = { ...publish, sentCode: true };
const rotate: PublishAttempt = {
  action: "rotate",
  sentSources: false,
  sentCode: false,
};

describe("classifyPublishFailure", () => {
  it("maps the access code reasons by the server message", () => {
    expect(
      classifyPublishFailure(
        err(
          "BadRequestError",
          "The current access code is required to republish this site"
        ),
        publish
      )
    ).toEqual({ kind: "access_code_required" });
    expect(
      classifyPublishFailure(
        err("BadRequestError", "The access code does not match the live site"),
        publish
      )
    ).toEqual({ kind: "incorrect_code" });
  });

  it("treats a 404 as missing stored sources only when none were sent", () => {
    expect(
      classifyPublishFailure(err("NotFoundError", "Not found"), publish)
    ).toEqual({ kind: "sources_missing" });
    expect(
      classifyPublishFailure(err("NotFoundError", "Not found"), {
        ...publish,
        sentSources: true,
      })
    ).toEqual({ kind: "source_not_found" });
  });

  it("maps a 409 and rate limiting", () => {
    expect(
      classifyPublishFailure(err("RequestError", conflictMessage, 409), publish)
    ).toEqual({ kind: "state_conflict" });
    expect(
      classifyPublishFailure(err("RateLimitExceededError", "slow"), publish)
    ).toEqual({ kind: "rate_limited" });
  });

  it("passes other messages through and survives odd input", () => {
    expect(
      classifyPublishFailure(
        err("BadRequestError", "A site cannot be published without pages"),
        publish
      )
    ).toEqual({
      kind: "message",
      message: "A site cannot be published without pages",
    });
    expect(classifyPublishFailure(undefined, publish)).toEqual({
      kind: "message",
      message: "",
    });
  });
});

describe("tie to the server's real errors", () => {
  const asBadRequest = (error: Error) => err("BadRequestError", error.message);

  it("recognises the server's access code errors", () => {
    expect(
      classifyPublishFailure(
        asBadRequest(new AccessCodeRequiredError()),
        publish
      )
    ).toEqual({ kind: "access_code_required" });
    expect(
      classifyPublishFailure(asBadRequest(new IncorrectCodeError()), withCode)
    ).toEqual({ kind: "incorrect_code" });
    expect(new AccessCodeRequiredError().message).toMatch(
      new RegExp(`^${ACCESS_CODE_REQUIRED}`)
    );
    expect(new IncorrectCodeError().message).toMatch(
      new RegExp(`^${INCORRECT_CODE}`)
    );
  });

  it("keeps the rotate repair when a republish with a code gets an unknown 400", () => {
    expect(
      classifyPublishFailure(
        err("BadRequestError", "Some reworded server message"),
        withCode
      )
    ).toEqual({
      kind: "message",
      message: "Some reworded server message",
      offerRotate: true,
    });
    expect(
      classifyPublishFailure(
        err("BadRequestError", "Some reworded server message"),
        publish
      )
    ).toEqual({ kind: "message", message: "Some reworded server message" });
  });

  it("tells a rotation 409 from a publish 409", () => {
    const conflict = err("RequestError", conflictMessage, 409);
    expect(classifyPublishFailure(conflict, rotate)).toEqual({
      kind: "nothing_to_rotate",
    });
    expect(classifyPublishFailure(conflict, publish)).toEqual({
      kind: "state_conflict",
    });
    // The client sees neither message; the two server reasons stay distinct.
    expect(new NothingToRotateError().message).not.toBe(
      new NoLivePageError().message
    );
  });
});

describe("isStaleCleanupWarning", () => {
  it("recognises both cleanup warnings and no others", () => {
    expect(
      isStaleCleanupWarning(
        "Old objects could not be cleaned up; they remain in storage"
      )
    ).toBe(true);
    expect(
      isStaleCleanupWarning(
        "3 old object(s) could not be removed; they remain in storage"
      )
    ).toBe(true);
    expect(
      isStaleCleanupWarning("Skipped 2 document(s) you cannot read.")
    ).toBe(false);
  });
});

describe("createErrorField", () => {
  it("routes server messages to their field", () => {
    expect(createErrorField("This address is already in use")).toBe("slug");
    expect(createErrorField("The address is reserved")).toBe("slug");
    expect(createErrorField("The domain must not be an IP address")).toBe(
      "hostname"
    );
    expect(createErrorField("This domain is already in use")).toBe("hostname");
    expect(createErrorField("Error 500")).toBe("form");
  });
});
