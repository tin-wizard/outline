import { canUseAIAnswers } from "./useAIAnswersEnabled";

const ok = {
  available: true,
  preference: true,
  isGuest: false,
  isViewer: false,
};

describe("canUseAIAnswers", () => {
  it("is on for members and admins when available and preferred", () => {
    expect(canUseAIAnswers(ok)).toBe(true);
  });

  it.each([
    ["server unavailable", { available: false }],
    ["preference off", { preference: false }],
    ["guest", { isGuest: true }],
    ["viewer", { isViewer: true }],
  ])("is off for %s", (_name, patch) => {
    expect(canUseAIAnswers({ ...ok, ...patch })).toBe(false);
  });
});
