import { randomUUID } from "node:crypto";
import { INDEX_PAGE_KEY, documentPageKey } from "./pageKeys";
import { isValidPageKey } from "./keys";

describe("documentPageKey", () => {
  it("is p- plus the first 12 hex characters of SHA-256 over the id", () => {
    // sha256("abc") = ba7816bf8f01cfea...
    expect(documentPageKey("abc")).toBe("p-ba7816bf8f01.html");
  });

  it("is stable across calls and always valid", () => {
    const id = randomUUID();
    expect(documentPageKey(id)).toBe(documentPageKey(id));
    expect(documentPageKey(id)).toMatch(/^p-[0-9a-f]{12}\.html$/);
    expect(isValidPageKey(documentPageKey(id))).toBe(true);
  });

  it("is unique for different ids and never the index", () => {
    const keys = new Set(
      Array.from({ length: 1000 }, () => documentPageKey(randomUUID()))
    );
    expect(keys.size).toBe(1000);
    expect(keys.has(INDEX_PAGE_KEY)).toBe(false);
  });

  it("contains no part of the id", () => {
    // Fixed, so a random 4-hex segment can never collide with the hash.
    const id = "6f1c2a9e-0d4b-4c3a-9e7f-2b8d5a1c3e90";
    for (const part of id.split("-")) {
      expect(documentPageKey(id)).not.toContain(part);
    }
  });
});
