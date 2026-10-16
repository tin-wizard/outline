import { isDocPath } from "./AnswerTurn";

vi.mock("~/components/Button", () => ({ default: () => null }));

describe("isDocPath", () => {
  it.each([
    "/doc/leave-policy-AbC123",
    "/doc/leave-policy-AbC123#h-pto",
    "/doc/a-b_c.d",
    "/doc/x#h-a%20b",
  ])("accepts %s", (url) => {
    expect(isDocPath(url)).toBe(true);
  });

  it.each([
    "/doc/../logout",
    "/doc/..",
    "/doc/.",
    "/doc/%2e%2e/%2e%2e/settings",
    "/doc/%2E%2E",
    "/doc/a%2fb",
    "/doc/a%5Cb",
    "/doc//evil.com",
    "//evil.com/doc/x",
    "/doc/a/b",
    "/doc/a?x=1",
    "/doc/a\\b",
    "/doc/a b",
    "/doc/a\u0000b",
    "/doc/a\tb",
    "/doc/a\u202eb",
    "/doc/a#x\u2066y",
    "/doc/",
    "/doc",
    "javascript:alert(1)",
    "https://evil.example/doc/x",
    "/other/x",
    "",
  ])("rejects %j", (url) => {
    expect(isDocPath(url)).toBe(false);
  });
});
