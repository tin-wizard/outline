/** The headings the chat list is grouped under, newest first. */
export type ConversationGroupKey =
  | "pinned"
  | "today"
  | "yesterday"
  | "previous7Days"
  | "previous30Days"
  | "older";

export interface ConversationGroup<T> {
  key: ConversationGroupKey;
  items: T[];
}

interface Groupable {
  pinnedAt?: string | null;
  updatedAt: string;
}

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  ).getTime();
}

/**
 * Splits conversations into Pinned / Today / Yesterday / Previous 7 days /
 * Previous 30 days / Older by their last update, in local calendar days.
 * Keeps the input order within a group and omits empty groups.
 *
 * @param items conversations, already sorted for display.
 * @param now the current time.
 * @returns the non-empty groups, in display order.
 */
export function groupConversations<T extends Groupable>(
  items: T[],
  now: Date = new Date()
): ConversationGroup<T>[] {
  const today = startOfDay(now);
  const buckets = new Map<ConversationGroupKey, T[]>();

  for (const item of items) {
    const updated = new Date(item.updatedAt).getTime();
    let key: ConversationGroupKey;
    if (item.pinnedAt) {
      key = "pinned";
    } else if (Number.isNaN(updated)) {
      key = "older";
    } else if (updated >= today) {
      key = "today";
    } else if (updated >= today - DAY) {
      key = "yesterday";
    } else if (updated >= today - 7 * DAY) {
      key = "previous7Days";
    } else if (updated >= today - 30 * DAY) {
      key = "previous30Days";
    } else {
      key = "older";
    }
    buckets.set(key, [...(buckets.get(key) ?? []), item]);
  }

  return (
    [
      "pinned",
      "today",
      "yesterday",
      "previous7Days",
      "previous30Days",
      "older",
    ] as const
  )
    .filter((key) => buckets.has(key))
    .map((key) => ({ key, items: buckets.get(key) ?? [] }));
}
