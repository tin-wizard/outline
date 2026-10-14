import type { ObjectStore } from "../lib/objectStore";

type Operation = "put" | "get" | "delete" | "list";

interface Entry {
  body: Uint8Array;
  contentType: string;
  cacheControl?: string;
}

/** In-memory ObjectStore with inspection helpers. It has no key guard. */
export interface MemoryStore extends ObjectStore {
  /** Every key currently stored, sorted. */
  keys(): string[];
  /** The stored body of a key decoded as UTF-8, or undefined. */
  text(key: string): string | undefined;
  /** The stored metadata of a key, or undefined. */
  meta(key: string): { contentType: string; cacheControl?: string } | undefined;
  /** Makes the given operation on the given key throw. */
  failOn(operation: Operation, key: string): void;
  /** Every operation attempted, as "<operation> <key or prefix>". */
  calls: string[];
}

/**
 * Creates an in-memory ObjectStore for tests. It deliberately has no key
 * guard so tests can prove the guarded wrapper is what protects the bucket.
 *
 * @param initial optional text objects to seed, keyed by object key.
 * @returns the store.
 */
export function createMemoryStore(
  initial: Record<string, string> = {}
): MemoryStore {
  const objects = new Map<string, Entry>();
  const failures = new Set<string>();
  const calls: string[] = [];
  const encoder = new TextEncoder();

  const enter = (operation: Operation, key: string) => {
    calls.push(`${operation} ${key}`);
    if (failures.has(`${operation} ${key}`)) {
      throw new Error(`memory store: injected ${operation} failure`);
    }
  };

  for (const [key, text] of Object.entries(initial)) {
    objects.set(key, {
      body: encoder.encode(text),
      contentType: "text/plain",
    });
  }

  return {
    calls,
    async put(key, body, options) {
      enter("put", key);
      objects.set(key, {
        body: typeof body === "string" ? encoder.encode(body) : body,
        ...options,
      });
    },
    async get(key) {
      enter("get", key);
      return objects.get(key)?.body ?? null;
    },
    async delete(key) {
      enter("delete", key);
      objects.delete(key);
    },
    async list(prefix) {
      enter("list", prefix);
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    keys: () => [...objects.keys()].sort(),
    text(key) {
      const entry = objects.get(key);
      return entry ? new TextDecoder().decode(entry.body) : undefined;
    },
    meta(key) {
      const entry = objects.get(key);
      return entry
        ? { contentType: entry.contentType, cacheControl: entry.cacheControl }
        : undefined;
    },
    failOn(operation, key) {
      failures.add(`${operation} ${key}`);
    },
  };
}
