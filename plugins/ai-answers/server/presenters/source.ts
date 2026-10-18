import { Collection, User } from "@server/models";
import type { Document } from "@server/models";
import { can } from "@server/policies";
import { redactSecrets } from "../redact";

/** Metadata of a source document, as its reader may see it. */
export interface SourceDetails {
  /** Only for collections the reader can access. */
  collectionId?: string;
  collectionName?: string;
  /** The collection's colour, when it has one. */
  collectionColor?: string;
  /** ISO time of the document's last change. */
  updatedAt: string;
  /** Display name of the last editor, when the reader may see that user. */
  updatedByName?: string;
  /** ISO time the document was published; absent for drafts. */
  publishedAt?: string;
}

/**
 * Names and colours of the collections the user can access, scoped by team;
 * other ids are left out. Names are redacted.
 *
 * @param user the reader.
 * @param ids collection ids, possibly repeated, null or inaccessible.
 * @returns a map from accessible collection id to its name and colour.
 */
export async function accessibleCollections(
  user: User,
  ids: (string | null | undefined)[]
): Promise<Map<string, { name: string; color?: string }>> {
  // Uncached: the shared cache can lag a revoked access by seconds.
  const accessible = new Set(await user.collectionIds({ skipCache: true }));
  const wanted = [...new Set(ids)].filter(
    (id): id is string => !!id && accessible.has(id)
  );
  if (wanted.length === 0) {
    return new Map();
  }
  const collections = await Collection.findAll({
    where: { id: wanted, teamId: user.teamId },
    attributes: ["id", "name", "color"],
  });
  return new Map(
    collections.map((c) => [
      c.id,
      {
        name: redactSecrets(c.name).text,
        ...(c.color ? { color: c.color } : {}),
      },
    ])
  );
}

/**
 * Metadata of documents the user may read: collection (accessible ones only),
 * update and publish times, and the last editor's name (same rule as the
 * document presenter: a user of the same team the reader may read).
 *
 * @param user the reader.
 * @param documents documents already authorised for the reader.
 * @returns a map from document id to its details.
 */
export async function presentSourceDetails(
  user: User,
  documents: Document[]
): Promise<Map<string, SourceDetails>> {
  const editorIds = [
    ...new Set(documents.map((d) => d.lastModifiedById).filter(Boolean)),
  ];
  const [collections, editors] = await Promise.all([
    accessibleCollections(
      user,
      documents.map((d) => d.collectionId)
    ),
    editorIds.length > 0
      ? User.findAll({
          where: { id: editorIds, teamId: user.teamId },
          attributes: ["id", "name", "teamId"],
        })
      : Promise.resolve([]),
  ]);
  const names = new Map(
    editors.filter((e) => can(user, "read", e)).map((e) => [e.id, e.name])
  );
  return new Map(
    documents.map((d) => {
      const collection = d.collectionId
        ? collections.get(d.collectionId)
        : undefined;
      const updatedByName = names.get(d.lastModifiedById);
      const details: SourceDetails = {
        ...(collection && d.collectionId
          ? {
              collectionId: d.collectionId,
              collectionName: collection.name,
              ...(collection.color
                ? { collectionColor: collection.color }
                : {}),
            }
          : {}),
        updatedAt: d.updatedAt.toISOString(),
        ...(updatedByName ? { updatedByName } : {}),
        ...(d.publishedAt ? { publishedAt: d.publishedAt.toISOString() } : {}),
      };
      return [d.id, details];
    })
  );
}
