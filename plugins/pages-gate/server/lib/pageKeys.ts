import crypto from "node:crypto";
import { assertValidPageKey } from "./keys";

/** Page key of the entry page of every published site. */
export const INDEX_PAGE_KEY = "index.html";

/**
 * Builds the opaque page key of a document: `p-<12 hex>.html`, the first 12
 * hex characters of SHA-256 over the document id. The title is never part of
 * the key, so it cannot reach URLs, browser history, CDN logs or referrers;
 * it is stored on the publication row instead.
 *
 * @param documentId the document id.
 * @returns a valid page key, the same for every call with the same id.
 * @throws {InvalidPageKeyError} when the result is not a valid page key.
 */
export function documentPageKey(documentId: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(documentId, "utf8")
    .digest("hex");
  const key = `p-${hash.slice(0, 12)}.html`;
  assertValidPageKey(key);
  return key;
}
