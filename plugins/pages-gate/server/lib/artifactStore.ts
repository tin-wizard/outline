import { assertSafePath } from "./artifactPaths";
import { assertValidSlug } from "./keys";
import type { ObjectStore } from "./objectStore";

/** The files of one published artifact, addressed by path relative to it. */
export interface ArtifactStore {
  /** Writes a file, replacing any existing one. */
  put(
    path: string,
    body: Uint8Array | string,
    options: { contentType: string; cacheControl?: string }
  ): Promise<void>;
  /** Every file of the artifact, as paths relative to its prefix. */
  list(): Promise<string[]>;
  /** Deletes one file. Deleting a missing file succeeds. */
  delete(path: string): Promise<void>;
  /** Deletes every file of the artifact and returns how many were deleted. */
  removeAll(): Promise<number>;
}

/**
 * Builds the object-store prefix that holds every file of an artifact.
 *
 * @param slug the site slug.
 * @returns `artifacts/<slug>/`.
 * @throws {InvalidSlugError} when the slug is invalid or reserved.
 */
export function artifactPrefix(slug: string): string {
  assertValidSlug(slug);
  return `artifacts/${slug}/`;
}

/**
 * Wraps a store so every read, write and delete stays inside one artifact's
 * prefix. R2 keys are bucket-wide, so all artifact access goes through this.
 *
 * @param store the raw object store.
 * @param slug the site slug.
 * @returns the guarded store.
 * @throws {InvalidSlugError} when the slug is invalid or reserved.
 */
export function createArtifactStore(
  store: ObjectStore,
  slug: string
): ArtifactStore {
  const prefix = artifactPrefix(slug);

  const list = async () => {
    const keys = await store.list(prefix);
    return keys.map((key) => {
      if (!key.startsWith(prefix)) {
        throw new Error("Object listing returned a key outside the artifact");
      }
      return key.slice(prefix.length);
    });
  };

  // async so an unsafe path rejects the promise instead of throwing synchronously.
  const guarded: ArtifactStore = {
    async put(path, body, options) {
      await store.put(`${prefix}${assertSafePath(path)}`, body, options);
    },
    list,
    async delete(path) {
      await store.delete(`${prefix}${assertSafePath(path)}`);
    },
    async removeAll() {
      const paths = await list();
      for (const path of paths) {
        await store.delete(`${prefix}${path}`);
      }
      // A listing can undercount, so verify before reporting success.
      if ((await list()).length > 0) {
        throw new Error("Some published files could not be removed");
      }
      return paths.length;
    },
  };
  return guarded;
}
