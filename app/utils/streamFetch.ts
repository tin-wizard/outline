import { CSRF } from "@shared/constants";
import EDITOR_VERSION from "@shared/editor/version";
import { Scope } from "@shared/types";
import AuthenticationHelper from "@shared/helpers/AuthenticationHelper";
import { version } from "../../package.json";
import env from "~/env";
import { getCSRFToken } from "./csrf";
import { NetworkError, OfflineError, RequestError } from "./errors";

/*
 * Event shapes mirror `AskEvents` in plugins/ai-answers/server/api/ask.ts.
 * Copied rather than imported so no server code enters the app bundle; keep
 * them in sync by hand.
 */

export type AskFailure =
  | "no_answer"
  | "unverified"
  | "budget"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "error";

export interface AskSource {
  /** 1-based citation number. */
  n: number;
  documentId: string;
  title: string;
  url: string;
  collectionName?: string;
}

export interface AskCitation {
  /** Matches `AskSource.n`. */
  n: number;
  documentId: string;
  title: string;
  url: string;
  quote?: string;
}

export interface AskEvents {
  conversation: { id: string };
  status: { phase: "searching" | "generating" | "notice"; message?: string };
  sources: AskSource[];
  block: {
    index: number;
    kind:
      | "paragraph"
      | "heading"
      | "listItem"
      | "tableHeader"
      | "tableRow"
      | "code";
    markdown: string;
    citations: AskCitation[];
  };
  done: {
    conversationId: string | null;
    usage: { inputTokens: number; outputTokens: number };
    timings: { retrievalMs: number; firstBlockMs?: number; totalMs: number };
  };
  failed: { reason: AskFailure; partial: boolean };
}

/** A parsed server-sent event, discriminated by `event`. */
export type AskEvent = {
  [K in keyof AskEvents]: { event: K; data: AskEvents[K] };
}[keyof AskEvents];

/** Error thrown for a non-2xx response; carries the HTTP status and the server's error code. */
export class StreamRequestError extends RequestError {
  name = "StreamRequestError";

  constructor(
    message: string,
    /** HTTP status of the response. */
    public status: number,
    /** The server's structured error code, if it sent one. */
    public code?: string
  ) {
    super(message);
  }
}

const eventNames = new Set<string>([
  "conversation",
  "status",
  "sources",
  "block",
  "done",
  "failed",
]);

function isEventName(name: string): name is keyof AskEvents {
  return eventNames.has(name);
}

/**
 * Builds the error for a failed response from its status and JSON body, like
 * `ApiClient.toError` but as a single class carrying `status` and `code`. The
 * global unauthorized handler is NOT triggered; callers handle 401 themselves.
 */
async function toError(response: Response): Promise<StreamRequestError> {
  let message = "";
  let code: string | undefined;
  try {
    const parsed: { message?: string; error?: string } = await response.json();
    message = parsed.message ?? "";
    code = parsed.error;
  } catch (_err) {
    // body was not JSON
  }
  const { status } = response;
  const fallback =
    status === 429
      ? "Too many requests, try again in a minute."
      : `Error ${status}`;
  return new StreamRequestError(message || fallback, status, code);
}

/** Parses one frame (lines between blank lines); returns undefined for comments-only frames. */
function parseFrame(raw: string): { name: string; data: string } | undefined {
  let name = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) {
      continue;
    }
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "event") {
      name = value;
    } else if (field === "data") {
      data.push(value);
    }
  }
  return data.length ? { name, data: data.join("\n") } : undefined;
}

/**
 * POSTs JSON to `/api/${path}` and yields the server-sent events of the
 * response as they arrive. Auth headers mirror `ApiClient.fetch`: same-origin
 * credentials, a CSRF header for non-read-scoped paths, and the client
 * version headers. There are no retries, deduplication or caching.
 *
 * Abort: when `signal` aborts (before or during the stream) the reader is
 * cancelled and the generator simply ends without throwing. Callers detect
 * that with `signal.aborted` after the loop. Unknown event names are skipped.
 * A malformed `data` payload for a known event ends the stream with a single
 * client-made `failed` event (`reason: "error"`, `partial` true if a block was
 * already yielded).
 *
 * @param path the API method, such as "ai.ask"; a leading slash is optional.
 * @param body the JSON request body.
 * @param options.signal aborts the request and the stream.
 * @returns an async iterable of events.
 * @throws {StreamRequestError} on a non-2xx response, with `status` and `code`.
 * @throws {NetworkError | OfflineError} if the request could not be made.
 */
export async function* streamFetch(
  path: string,
  body: object,
  options: { signal?: AbortSignal } = {}
): AsyncGenerator<AskEvent, void, undefined> {
  const { signal } = options;
  if (signal?.aborted) {
    return;
  }

  const headers = new Headers({
    Accept: "text/event-stream",
    "cache-control": "no-cache",
    "x-editor-version": EDITOR_VERSION,
    "x-api-version": "4",
    "x-client-version": env.VERSION ? `${version}-${env.VERSION}` : version,
    pragma: "no-cache",
    "Content-Type": "application/json",
  });
  // Same rule as ApiClient: POSTs need CSRF unless the path is read-scoped.
  if (!AuthenticationHelper.canAccess(path, [Scope.Read])) {
    const token = getCSRFToken();
    if (token) {
      headers.set(CSRF.headerName, token);
    }
  }

  let response: Response;
  try {
    response = await fetch(`/api/${path.replace(/^\//, "")}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers,
      redirect: "follow",
      credentials: "same-origin",
      cache: "no-cache",
      signal,
    });
  } catch (_err) {
    if (signal?.aborted) {
      return;
    }
    throw window.navigator.onLine
      ? new NetworkError("A network error occurred, try again?")
      : new OfflineError("No internet connection available");
  }

  if (!response.ok) {
    throw await toError(response);
  }
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawBlock = false;
  let finished = false;
  // Real fetch bodies error on abort; this also unblocks a pending read otherwise.
  const handleAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", handleAbort, { once: true });

  try {
    while (!finished) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (signal?.aborted) {
          return;
        }
        throw err;
      }
      if (signal?.aborted) {
        return;
      }
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      // A trailing CR may be half of a CRLF; wait for the next chunk.
      const held = !chunk.done && buffer.endsWith("\r") ? "\r" : "";
      buffer = buffer
        .slice(0, buffer.length - held.length)
        .replace(/\r\n?/g, "\n");

      const frames = buffer.split("\n\n");
      buffer = (frames.pop() ?? "") + held;
      if (chunk.done && buffer.trim()) {
        frames.push(buffer);
        buffer = "";
      }

      for (const raw of frames) {
        const frame = parseFrame(raw);
        if (!frame || !isEventName(frame.name)) {
          continue;
        }
        let event: AskEvent;
        try {
          // shortcut: payload shape is trusted from the server, not validated.
          event = {
            event: frame.name,
            data: JSON.parse(frame.data),
          } as AskEvent;
        } catch (_err) {
          yield {
            event: "failed",
            data: { reason: "error", partial: sawBlock },
          };
          return;
        }
        sawBlock ||= event.event === "block";
        yield event;
        if (signal?.aborted) {
          return;
        }
      }
      finished = chunk.done;
    }
  } finally {
    signal?.removeEventListener("abort", handleAbort);
    // Cancel is a no-op on a closed stream; on early exit it stops the download.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
