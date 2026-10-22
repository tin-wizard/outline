import type {
  ProviderErrorKind,
  ProviderStreamEvent,
  StreamingProvider,
  StreamRequest,
} from "../contract";
import type { ProviderHealth } from "./health";
import { defaultHealth } from "./health";

/** How long a provider may stay silent before failing over (judgement; no source gave a value). */
export const FIRST_EVENT_TIMEOUT_MS = 8_000;

/** Every provider failed before answering with a failover-class error. */
export class AllProvidersFailedError extends Error {
  public attempts: { provider: string; kind: ProviderErrorKind }[];

  constructor(attempts: { provider: string; kind: ProviderErrorKind }[]) {
    super(
      `All AI providers failed: ${attempts
        .map((attempt) => `${attempt.provider} (${attempt.kind})`)
        .join(", ")}`
    );
    this.name = "AllProvidersFailedError";
    this.attempts = attempts;
  }
}

/**
 * Streams an answer from the first provider that answers, failing over to the
 * next one only when a provider fails before its first event.
 *
 * @param providers the providers in failover order.
 * @param request the streamed answer request.
 * @param health the breaker state; defaults to the in-process one.
 * @returns the events of the provider that answered.
 * @throws AllProvidersFailedError when every provider failed with a failover-class error.
 * @throws the original error on abort, `bad_request`, `other` or a failure after the first event.
 */
export async function* streamWithFallback(
  providers: StreamingProvider[],
  request: StreamRequest,
  health: ProviderHealth = defaultHealth
): AsyncGenerator<ProviderStreamEvent> {
  const healthy = providers.filter((provider) => !health.isOpen(provider.id));
  const candidates = healthy.length > 0 ? healthy : providers;
  const attempts: { provider: string; kind: ProviderErrorKind }[] = [];

  for (const [index, provider] of candidates.entries()) {
    if (request.progress) {
      request.progress.served = {
        provider: provider.id,
        model: provider.model,
      };
    }

    // A child controller, so a first-event timeout aborts only this attempt.
    const controller = new AbortController();
    const abortAttempt = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", abortAttempt);
    if (request.signal?.aborted) {
      abortAttempt();
    }
    let timedOut = false;
    const timer =
      index < candidates.length - 1
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, FIRST_EVENT_TIMEOUT_MS)
        : undefined;
    let yielded = false;

    try {
      for await (const event of provider.stream({
        ...request,
        signal: controller.signal,
      })) {
        clearTimeout(timer);
        yielded = true;
        yield event;
      }
      return;
    } catch (error) {
      if (yielded || request.signal?.aborted || !(error instanceof Error)) {
        throw error;
      }
      const kind = timedOut ? "network" : provider.classify(error);
      if (kind === "bad_request" || kind === "other") {
        throw error;
      }
      health.trip(provider.id, kind);
      attempts.push({ provider: provider.id, kind });
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abortAttempt);
    }
  }

  throw new AllProvidersFailedError(attempts);
}
