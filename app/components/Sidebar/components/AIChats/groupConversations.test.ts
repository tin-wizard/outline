import { groupConversations } from "./groupConversations";

const now = new Date(2026, 9, 18, 15, 0, 0); // local time, Oct 18 2026
const at = (daysAgo: number, hour = 12) =>
  new Date(2026, 9, 18 - daysAgo, hour).toISOString();

describe("groupConversations", () => {
  it("groups by local calendar day and keeps order within a group", () => {
    const items = [
      { id: "a", updatedAt: at(0, 9) },
      { id: "b", updatedAt: at(0, 1) },
      { id: "c", updatedAt: at(1, 23) },
      { id: "d", updatedAt: at(2) },
      { id: "e", updatedAt: at(7) },
      { id: "f", updatedAt: at(8) },
      { id: "g", updatedAt: at(30) },
      { id: "h", updatedAt: at(31) },
    ];
    const groups = groupConversations(items, now);
    expect(groups.map((g) => [g.key, g.items.map((i) => i.id)])).toEqual([
      ["today", ["a", "b"]],
      ["yesterday", ["c"]],
      ["previous7Days", ["d", "e"]],
      ["previous30Days", ["f", "g"]],
      ["older", ["h"]],
    ]);
  });

  it("puts pinned conversations first regardless of age", () => {
    const groups = groupConversations(
      [
        { id: "old", updatedAt: at(90), pinnedAt: at(1) },
        { id: "new", updatedAt: at(0) },
      ],
      now
    );
    expect(groups.map((g) => g.key)).toEqual(["pinned", "today"]);
  });

  it("omits empty groups and tolerates bad dates", () => {
    expect(groupConversations([], now)).toEqual([]);
    expect(
      groupConversations([{ id: "x", updatedAt: "nope" }], now)[0].key
    ).toBe("older");
  });
});
