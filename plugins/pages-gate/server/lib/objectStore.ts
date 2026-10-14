import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  assertKeyWithinSite,
  assertPrefixWithinSite,
  assertValidSlug,
  sitePrefix,
} from "./keys";

/** The only way the plugin touches the bucket. */
export interface ObjectStore {
  /**
   * Writes an object, replacing any existing one.
   *
   * @param key the full object key.
   * @param body the object body.
   * @param options the content type and optional cache control header.
   */
  put(
    key: string,
    body: Uint8Array | string,
    options: { contentType: string; cacheControl?: string }
  ): Promise<void>;

  /**
   * Reads an object.
   *
   * @param key the full object key.
   * @returns the bytes, or null when the key does not exist.
   * @throws any failure other than a missing key.
   */
  get(key: string): Promise<Uint8Array | null>;

  /**
   * Deletes an object. Deleting a missing key succeeds.
   *
   * @param key the full object key.
   */
  delete(key: string): Promise<void>;

  /**
   * Lists every key under a prefix, following pagination to the end.
   *
   * @param prefix the key prefix.
   * @returns the keys.
   */
  list(prefix: string): Promise<string[]>;
}

/**
 * Creates an S3 client for a Cloudflare R2 bucket.
 *
 * @param config the R2 account id and API credentials.
 * @returns the client.
 * @throws when the account id is not 32 lowercase hex characters.
 */
export function createR2Client(config: {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}): S3Client {
  if (!/^[a-f0-9]{32}$/.test(config.accountId)) {
    throw new Error("R2 account id must be 32 lowercase hex characters");
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // Recent SDK versions add CRC32 checksums by default, which R2 rejects.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/**
 * Creates an ObjectStore backed by an R2 bucket. It never reads process.env.
 *
 * shortcut: always a single PutObject (R2 allows 5 GiB per request), no
 * multipart upload; upgrade if pages ever approach that size.
 *
 * @param args the client (anything with `send`) and the bucket name.
 * @returns the store.
 */
export function createR2Store(args: {
  client: Pick<S3Client, "send">;
  bucket: string;
}): ObjectStore {
  const { client, bucket } = args;
  return {
    async put(key, body, options) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          CacheControl: options.cacheControl,
        })
      );
    },
    async get(key) {
      try {
        const result = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key })
        );
        return (await result.Body?.transformToByteArray()) ?? null;
      } catch (err) {
        if (err instanceof Error && err.name === "NoSuchKey") {
          return null;
        }
        throw err;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
          })
        );
        for (const object of page.Contents ?? []) {
          if (object.Key !== undefined) {
            keys.push(object.Key);
          }
        }
        if (!page.IsTruncated) {
          break;
        }
        // A truncated page must lead somewhere new; ending here would
        // undercount, and callers rely on the listing to find leftovers.
        const next = page.NextContinuationToken;
        if (!next || next === token) {
          throw new Error("Object listing is truncated without a new token");
        }
        token = next;
      } while (token);
      return keys;
    },
  };
}

/**
 * Wraps a store so every key and prefix must lie within one site. R2 keys are
 * bucket-wide, so all plugin bucket access goes through this.
 *
 * @param store the store to guard.
 * @param slug the site slug.
 * @returns the guarded store, with `removeAll` to delete the whole site.
 * @throws {InvalidSlugError} when the slug is invalid.
 */
export function createGuardedStore(
  store: ObjectStore,
  slug: string
): ObjectStore & { removeAll(): Promise<number> } {
  assertValidSlug(slug);

  const guarded: ObjectStore & { removeAll(): Promise<number> } = {
    async put(key, body, options) {
      assertKeyWithinSite(slug, key);
      return store.put(key, body, options);
    },
    async get(key) {
      assertKeyWithinSite(slug, key);
      return store.get(key);
    },
    async delete(key) {
      assertKeyWithinSite(slug, key);
      return store.delete(key);
    },
    async list(prefix) {
      assertPrefixWithinSite(slug, prefix);
      const keys = await store.list(prefix);
      for (const key of keys) {
        assertKeyWithinSite(slug, key);
      }
      return keys;
    },
    async removeAll() {
      const keys = await guarded.list(sitePrefix(slug));
      for (const key of keys) {
        await guarded.delete(key);
      }
      return keys.length;
    },
  };
  return guarded;
}
