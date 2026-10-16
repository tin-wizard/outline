import { InternalError } from "@server/errors";
import pagesEnv from "../env";
import type { ObjectStore } from "./objectStore";

let r2Store: ObjectStore | undefined;

/**
 * Builds the R2 store from the plugin env on first use, never at import.
 *
 * @returns the shared R2 object store.
 * @throws InternalError when the R2 settings are incomplete.
 */
export async function defaultStore(): Promise<ObjectStore> {
  if (!r2Store) {
    const { createR2Client, createR2Store } = await import("./objectStore");
    const {
      PAGES_R2_ACCOUNT_ID,
      PAGES_R2_ACCESS_KEY_ID,
      PAGES_R2_SECRET_ACCESS_KEY,
      PAGES_R2_BUCKET,
    } = pagesEnv;
    if (
      !PAGES_R2_ACCOUNT_ID ||
      !PAGES_R2_ACCESS_KEY_ID ||
      !PAGES_R2_SECRET_ACCESS_KEY ||
      !PAGES_R2_BUCKET
    ) {
      throw InternalError("Pages storage is not configured");
    }
    r2Store = createR2Store({
      client: createR2Client({
        accountId: PAGES_R2_ACCOUNT_ID,
        accessKeyId: PAGES_R2_ACCESS_KEY_ID,
        secretAccessKey: PAGES_R2_SECRET_ACCESS_KEY,
      }),
      bucket: PAGES_R2_BUCKET,
    });
  }
  return r2Store;
}
