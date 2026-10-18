import { canUseAIHistory } from "./useAIHistoryEnabled";

describe("canUseAIHistory", () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false], // guests, viewers and AI off never see history
    [false, false, false],
  ])("ai=%s history=%s => %s", (aiEnabled, preference, expected) => {
    expect(canUseAIHistory({ aiEnabled, preference })).toBe(expected);
  });
});
