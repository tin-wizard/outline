import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage } from "node:http";
import type { Transaction } from "sequelize";

/**
 * Tenant context resolved by the authentication middleware for the current
 * request. When present, database transactions for the request enforce
 * row-level security keyed on `teamId`.
 */
export type TenantContext = {
  /** The id of the authenticated user's team. */
  teamId: string;
  /** Whether the authenticated user has platform-wide access. */
  isPlatformAdmin: boolean;
};

/**
 * Async local storage for the current HTTP request context. This allows
 * downstream code (e.g. Sequelize hooks and the transaction wrapper) to check
 * whether the originating request is still alive without explicitly threading
 * `ctx` through every call, and to read the tenant resolved for the request so
 * transactions can set `app.team_id` for row-level security.
 */
export const requestContext = new AsyncLocalStorage<{
  req: IncomingMessage;
  tenant?: TenantContext;
  transaction?: Transaction;
}>();

/**
 * Commits the current request's tenant-scoped transaction early and detaches
 * it from the request context, returning its pooled connection before slow
 * non-database work (such as a model call). Later reads in the request run on
 * the pool outside any transaction, so row-level security is not forced for
 * them: callers must not read tenant data after calling this.
 *
 * @returns true if a transaction was committed, false if there was none.
 * @throws if the commit fails; the transaction is still detached.
 */
export async function releaseRequestTransaction(): Promise<boolean> {
  const store = requestContext.getStore();
  const transaction = store?.transaction;
  if (!store || !transaction) {
    return false;
  }
  // Detach first so nothing routes through it, even if the commit fails.
  store.transaction = undefined;
  releasedTransactions.add(transaction);
  await transaction.commit();
  return true;
}

/**
 * Returns whether a request transaction was already committed early by
 * releaseRequestTransaction, so the auth() middleware that created it must not
 * commit or roll it back again.
 *
 * @param transaction the transaction created by an auth() middleware.
 * @returns true if the transaction was released early.
 */
export function isTransactionReleased(transaction: Transaction): boolean {
  return releasedTransactions.has(transaction);
}

// Tracked per transaction rather than by comparing store.transaction, which a
// nested auth() (api.batch sub-requests) overwrites.
const releasedTransactions = new WeakSet<Transaction>();
