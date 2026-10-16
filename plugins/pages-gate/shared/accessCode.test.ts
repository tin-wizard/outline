import {
  CUSTOM_CODE_MAX_LENGTH,
  CUSTOM_CODE_MIN_LENGTH,
  customCodeProblem,
  normalizeCode,
} from "./accessCode";

describe("customCodeProblem", () => {
  it("accepts codes at the length boundaries", () => {
    expect(
      customCodeProblem("a".repeat(CUSTOM_CODE_MIN_LENGTH))
    ).toBeUndefined();
    expect(
      customCodeProblem("a".repeat(CUSTOM_CODE_MAX_LENGTH))
    ).toBeUndefined();
    expect(customCodeProblem("Sales-Kit/2026!")).toBeUndefined();
  });

  it("counts length after removing whitespace", () => {
    expect(customCodeProblem("a".repeat(CUSTOM_CODE_MIN_LENGTH - 1))).toBe(
      "length"
    );
    expect(customCodeProblem("a b c d e f g h i j k")).toBe("length");
    expect(customCodeProblem("a".repeat(CUSTOM_CODE_MAX_LENGTH + 1))).toBe(
      "length"
    );
    expect(customCodeProblem("")).toBe("length");
  });

  it("refuses characters outside printable ASCII", () => {
    expect(customCodeProblem("passwörd-passwörd")).toBe("characters");
    expect(customCodeProblem("emoji-code-🙂🙂")).toBe("characters");
  });
});

describe("normalizeCode", () => {
  it("lowercases and drops whitespace but keeps hyphens", () => {
    expect(normalizeCode(" AbCd-EFGH\tij ")).toBe("abcd-efghij");
  });
});
