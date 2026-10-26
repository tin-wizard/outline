import { Collection, type User } from "@server/models";

/**
 * Finds which of the given collections are excluded from AI (AI answers and
 * AI clients such as MCP) in the user's workspace.
 *
 * @param user the acting user; limits the lookup to their workspace.
 * @param collectionIds the collection ids to check, empty values are ignored.
 * @returns the ids of the excluded collections.
 */
export async function aiExcludedCollectionIds(
  user: User,
  collectionIds: (string | null | undefined)[]
): Promise<Set<string>> {
  const ids = [...new Set(collectionIds)].filter((id): id is string => !!id);
  if (ids.length === 0) {
    return new Set();
  }
  const excluded = await Collection.findAll({
    where: { id: ids, teamId: user.teamId, aiExcluded: true },
    attributes: ["id"],
    // A trashed collection's documents can still be searched.
    paranoid: false,
  });
  return new Set(excluded.map((c) => c.id));
}

/**
 * Whether a collection is excluded from AI in the user's workspace.
 *
 * @param user the acting user.
 * @param collectionId the collection id; no collection is never excluded.
 * @returns true when the collection is excluded.
 */
export async function isAIExcluded(
  user: User,
  collectionId: string | null | undefined
): Promise<boolean> {
  return (await aiExcludedCollectionIds(user, [collectionId])).size > 0;
}

/**
 * Drops items (documents, templates) in collections excluded from AI.
 *
 * @param user the acting user; limits the lookup to their workspace.
 * @param items the items to filter.
 * @returns the items that are not in an excluded collection, in order.
 */
export async function dropAIExcluded<
  T extends { collectionId?: string | null },
>(user: User, items: T[]): Promise<T[]> {
  const excluded = await aiExcludedCollectionIds(
    user,
    items.map((item) => item.collectionId)
  );
  return items.filter(
    (item) => !item.collectionId || !excluded.has(item.collectionId)
  );
}
