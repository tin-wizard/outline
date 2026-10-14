import type { Event } from "@sentry/node";
import Sentry from "@server/logging/sentry";

// koa-router matches routes case-insensitively, so the check must too.
const PAGES_ROUTE = /\/api\/pages\./i;
const SECRET_KEY = /accesscode/i;
const REDACTED = "[Filtered]";
const REGISTERED = Symbol.for("pages-gate.sentryScrubber");

/**
 * Drops the request body from Sentry events raised by the plugin's API
 * routes, and redacts any `accessCode` from other request bodies. Sentry
 * captures incoming bodies by default, and the pages.publish body carries
 * the access code, which the log sanitizer does not filter.
 *
 * @param event the Sentry event.
 * @returns the event, scrubbed.
 */
export function scrubPagesRequestBody(event: Event): Event {
  const request = event.request;
  if (!request) {
    return event;
  }
  if (request.url && PAGES_ROUTE.test(request.url)) {
    delete request.data;
    return event;
  }
  if (typeof request.data === "string") {
    if (SECRET_KEY.test(request.data)) {
      request.data = REDACTED;
    }
  } else {
    redactSecrets(request.data);
  }
  return event;
}

/**
 * Registers scrubPagesRequestBody on Sentry's global scope, once per process
 * however often it is called.
 */
export function registerSentryScrubber(): void {
  const flags = globalThis as typeof globalThis & { [REGISTERED]?: true };
  if (flags[REGISTERED]) {
    return;
  }
  flags[REGISTERED] = true;
  Sentry.getGlobalScope().addEventProcessor(scrubPagesRequestBody);
}

function redactSecrets(value: unknown, depth = 0): void {
  if (!value || typeof value !== "object" || depth > 10) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      Reflect.set(value, key, REDACTED);
    } else {
      redactSecrets(child, depth + 1);
    }
  }
}
