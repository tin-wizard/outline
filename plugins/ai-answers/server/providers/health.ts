import Logger from "@server/logging/Logger";
import Redis from "@server/storage/redis";
import type { ProviderErrorKind } from "../contract";

/** Tracks which providers recently failed, so the chain can skip them. */
export interface ProviderHealth {
  /**
   * Whether the provider's breaker is open (it failed recently).
   *
   * @param id the provider id.
   * @returns true while the provider is cooling down.
   */
  isOpen(id: string): boolean;
  /**
   * Opens the provider's breaker for the cooldown of the failure kind.
   *
   * @param id the provider id.
   * @param kind why the provider failed.
   */
  trip(id: string, kind: ProviderErrorKind): void;
}

/** How long a provider is skipped after each failover-class failure. */
export const COOLDOWN_MS: Record<
  Exclude<ProviderErrorKind, "bad_request" | "other">,
  number
> = {
  billing: 600_000,
  auth: 600_000,
  rate_limit: 30_000,
  overloaded: 30_000,
  network: 30_000,
};

// shortcut: per-process state, so each web instance learns separately; move to Redis if we run many instances.
const openUntil = new Map<string, number>();

/** The in-process provider health shared by all requests. */
export const defaultHealth: ProviderHealth = {
  isOpen: (id) => (openUntil.get(id) ?? 0) > Date.now(),
  trip: (id, kind) => {
    if (kind === "bad_request" || kind === "other") {
      return;
    }
    openUntil.set(id, Date.now() + COOLDOWN_MS[kind]);
  },
};

/**
 * Logs an error the first time in an hour that a provider fails with `kind`,
 * so an operator can top up credit or fix a key. Never throws.
 *
 * @param provider the provider id.
 * @param kind why the provider failed.
 * @returns when the alert was handled.
 */
export async function alertProviderDown(
  provider: string,
  kind: ProviderErrorKind
): Promise<void> {
  try {
    const first = await Redis.defaultClient.set(
      `ai-answers:provider-alert:${provider}:${kind}`,
      "1",
      "EX",
      3600,
      "NX"
    );
    if (first === "OK") {
      // Only the provider id and kind: never a message, question or answer.
      Logger.error(
        "AI answers provider unavailable",
        new Error("AI answers provider unavailable"),
        { provider, kind }
      );
    }
  } catch {
    // Alerting must never affect answering.
  }
}
