import {
  GENERATED_CODE,
  accessCodeChoiceProblem,
  newAccessCode,
} from "./accessCodeForm";

const custom = (code: string, confirm: string) => ({
  custom: true,
  code,
  confirm,
});

describe("accessCodeChoiceProblem", () => {
  it("accepts a generated code", () => {
    expect(accessCodeChoiceProblem(GENERATED_CODE)).toBeUndefined();
  });

  it("checks the chosen code before its confirmation", () => {
    expect(accessCodeChoiceProblem(custom("short", "short"))).toBe("length");
    expect(accessCodeChoiceProblem(custom("long-enough-code", ""))).toBe(
      "unconfirmed"
    );
    expect(
      accessCodeChoiceProblem(custom("long-enough-code", "long-enough-cod"))
    ).toBe("mismatch");
  });

  it("compares the codes as readers' typing is normalised", () => {
    expect(
      accessCodeChoiceProblem(custom("Long Enough Code", "longenoughcode"))
    ).toBeUndefined();
  });
});

describe("newAccessCode", () => {
  it("sends the chosen code only when the administrator sets one", () => {
    expect(newAccessCode(GENERATED_CODE)).toBeUndefined();
    expect(newAccessCode(custom("long-enough-code", "long-enough-code"))).toBe(
      "long-enough-code"
    );
  });
});
