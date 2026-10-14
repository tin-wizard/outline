import { canSubmitForm } from "./submitGuard";

const base = {
  pending: false,
  needsSources: false,
  sourceCount: 0,
  needsCode: false,
  codeLength: 0,
};

describe("canSubmitForm", () => {
  it("refuses while pending", () => {
    expect(canSubmitForm({ ...base, pending: true })).toBe(false);
  });

  it("requires a source on first publish", () => {
    expect(canSubmitForm({ ...base, needsSources: true })).toBe(false);
    expect(canSubmitForm({ ...base, needsSources: true, sourceCount: 1 })).toBe(
      true
    );
  });

  it("requires a typed code on republish", () => {
    expect(canSubmitForm({ ...base, needsCode: true })).toBe(false);
    expect(canSubmitForm({ ...base, needsCode: true, codeLength: 4 })).toBe(
      true
    );
  });

  it("allows a rotation with nothing else required", () => {
    expect(canSubmitForm(base)).toBe(true);
  });
});
