import Sentry from "@server/logging/sentry";
import { registerSentryScrubber, scrubPagesRequestBody } from "./sentry";

const BODY = '{"id":"x","accessCode":"abcd-efgh-jkmn-pqrs"}';

describe("scrubPagesRequestBody", () => {
  it.each([
    "https://kb.example.com/api/pages.publish",
    "https://kb.example.com/API/PAGES.PUBLISH",
    "https://kb.example.com/api/Pages.Publish",
    "https://kb.example.com/api/pages.publish/",
    "https://kb.example.com/api/pages.publish?x=1",
  ])("removes the body of %s", (url) => {
    const event = scrubPagesRequestBody({ request: { url, data: BODY } });
    expect(event.request).toEqual({ url });
  });

  it("keeps the body of a route that only contains pages. elsewhere", () => {
    const url = "https://kb.example.com/api/documents.pages.list";
    const event = scrubPagesRequestBody({ request: { url, data: "{}" } });
    expect(event.request?.data).toEqual("{}");
  });

  it("redacts an access code in a raw body on another route", () => {
    const event = scrubPagesRequestBody({
      request: { url: "https://kb.example.com/api/other", data: BODY },
    });
    expect(event.request?.data).toEqual("[Filtered]");
  });

  it("redacts an access code in an object body on another route", () => {
    const event = scrubPagesRequestBody({
      request: {
        url: "https://kb.example.com/api/other",
        data: { id: "x", nested: { AccessCode: "abcd-efgh-jkmn-pqrs" } },
      },
    });
    expect(event.request?.data).toEqual({
      id: "x",
      nested: { AccessCode: "[Filtered]" },
    });
  });
});

describe("registerSentryScrubber", () => {
  it("registers the processor once however often it runs", () => {
    const count = () =>
      Sentry.getGlobalScope()
        .getScopeData()
        .eventProcessors.filter((p) => p.name === "scrubPagesRequestBody")
        .length;

    registerSentryScrubber();
    registerSentryScrubber();

    expect(count()).toEqual(1);
  });
});
