import type * as NodeCrypto from "node:crypto";

/**
 * Iterations used instead of the gate's 600000 in tests that do not prove
 * browser compatibility. gate.test.ts and api/publishE2E.test.ts keep the
 * real count.
 */
export const TEST_PBKDF2_ITERATIONS = 1000;

/** The iteration count of every PBKDF2 derivation through a mocked module. */
export const pbkdf2Calls: number[] = [];

/**
 * Builds a `node:crypto` mock whose pbkdf2 and pbkdf2Sync run the real
 * algorithm, record each call and, when `iterations` is given, use that
 * count instead of the requested one. Use inside `vi.mock("node:crypto")`.
 *
 * @param actual the real module, from importOriginal.
 * @param iterations the forced iteration count, or undefined to keep it.
 * @returns the module to use in place of node:crypto.
 */
export function mockCryptoPbkdf2(
  actual: typeof NodeCrypto,
  iterations?: number
) {
  const pbkdf2: typeof actual.pbkdf2 = (
    password,
    salt,
    rounds,
    keylen,
    digest,
    callback
  ) => {
    const used = iterations ?? rounds;
    pbkdf2Calls.push(used);
    return actual.pbkdf2(password, salt, used, keylen, digest, callback);
  };
  const pbkdf2Sync: typeof actual.pbkdf2Sync = (
    password,
    salt,
    rounds,
    keylen,
    digest
  ) => {
    const used = iterations ?? rounds;
    pbkdf2Calls.push(used);
    return actual.pbkdf2Sync(password, salt, used, keylen, digest);
  };
  const overrides = { pbkdf2, pbkdf2Sync };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
}
