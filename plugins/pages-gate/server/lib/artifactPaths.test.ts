import { assertSafePath } from "./artifactPaths";

describe("assertSafePath", () => {
  it.each([
    "../x",
    "a/../../b",
    "/etc/passwd",
    "a\\b",
    "a\0b",
    "a\nb",
    "a\rb",
    "a\x01b",
    "a\x7fb",
    "a%2e%2e/b",
    "",
    "a//b",
    "a/",
    "./a",
    "a/./b",
    "x".repeat(201),
  ])("rejects %j", (p) => {
    expect(() => assertSafePath(p)).toThrow("Invalid artifact file path");
  });

  it("accepts nested relative paths and keeps case", () => {
    expect(assertSafePath("css/App.css")).toBe("css/App.css");
    expect(assertSafePath("index.html")).toBe("index.html");
  });

  it("accepts a 200 character path", () => {
    expect(assertSafePath("x".repeat(200))).toHaveLength(200);
  });
});
