import {
  COMPARE_SYSTEM_PROMPT,
  MAX_OUTPUT_TOKENS,
  STRUCTURED_SYSTEM_PROMPT,
  type ProviderErrorKind,
  type ProviderStreamEvent,
  type StreamRequest,
  type StreamingProvider,
  type Usage,
} from "../contract";
import { redactSecrets } from "../redact";
import { historyText } from "./anthropic";
import { PROMPT_CITATION_FORMAT, parsePromptedBlock } from "./promptCitations";

/** The part of `fetch` this module needs; lets tests pass a fake. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Options of the Gemini provider. */
export interface GoogleProviderOptions {
  /** `GEMINI_API_KEY`; when unset every call fails as `auth` before any request. */
  apiKey: string | undefined;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/** An error response of the Gemini API, or the missing key. */
export class GeminiError extends Error {
  /**
   * Builds an error from an HTTP status and the documented error body
   * `{ error: { code, message, status, details } }`. The vendor message is
   * kept for classification only, never in `message`, so it cannot reach logs.
   *
   * @param httpStatus the HTTP status, or undefined for an in-stream error.
   * @param body the parsed response body.
   * @returns the error.
   */
  public static fromBody(
    httpStatus: number | undefined,
    body: unknown
  ): GeminiError {
    const error = field(body, "error");
    const code = field(error, "code");
    const status = field(error, "status");
    const message = field(error, "message");
    const details = field(error, "details");
    const reasons = Array.isArray(details)
      ? details
          .map((d) => field(d, "reason"))
          .filter((r) => typeof r === "string")
      : [];
    return new GeminiError(
      httpStatus ?? (typeof code === "number" ? code : undefined),
      typeof status === "string" ? status : undefined,
      typeof message === "string" ? message : "",
      reasons
    );
  }

  public constructor(
    /** HTTP status, or the body's `code` for an in-stream error. */
    public readonly status: number | undefined,
    /** The gRPC status string, e.g. `RESOURCE_EXHAUSTED`. */
    public readonly apiStatus: string | undefined,
    /** The vendor's message; for classification only. */
    public readonly detail: string,
    /** `ErrorInfo` reasons from `details`, e.g. `API_KEY_INVALID`. */
    public readonly reasons: string[] = []
  ) {
    super(`Gemini API error ${status ?? "-"} ${apiStatus ?? "-"}`);
    this.name = "GeminiError";
  }
}

/**
 * A Gemini provider on the REST `streamGenerateContent` endpoint (SSE).
 * Citations are prompted with `PROMPT_CITATION_FORMAT`; lines whose citations
 * cannot be placed are dropped.
 *
 * @param model the model id, e.g. `gemini-3.8-flash`.
 * @param options the API key and an optional fetch.
 * @returns the provider.
 */
export function createGoogleProvider(
  model: string,
  options: GoogleProviderOptions
): StreamingProvider {
  return {
    id: "google",
    model,
    stream: (request) =>
      streamAnswer(model, options.apiKey, options.fetch ?? fetch, request),
    classify: classifyGoogleError,
  };
}

/**
 * Classifies an error thrown by the Gemini provider for failover, by HTTP
 * status and the body's status string. A 429 `RESOURCE_EXHAUSTED` is billing:
 * the docs use it for both rate limits and spend caps and document no field
 * that tells them apart.
 *
 * @param error the thrown error.
 * @returns the failure kind.
 */
export function classifyGoogleError(error: Error): ProviderErrorKind {
  if (!(error instanceof GeminiError)) {
    const code = "code" in error ? error.code : undefined;
    return code === "ECONNRESET" ||
      /fetch failed|terminated/.test(error.message)
      ? "network"
      : "other";
  }
  const { status, apiStatus, detail, reasons } = error;
  if (
    status === 402 ||
    status === 429 ||
    apiStatus === "RESOURCE_EXHAUSTED" ||
    (apiStatus === "FAILED_PRECONDITION" && /billing|free tier/i.test(detail))
  ) {
    return "billing";
  }
  if (
    status === 401 ||
    status === 403 ||
    apiStatus === "UNAUTHENTICATED" ||
    apiStatus === "PERMISSION_DENIED" ||
    reasons.includes("API_KEY_INVALID")
  ) {
    return "auth";
  }
  if (
    (status !== undefined && [500, 502, 503, 504].includes(status)) ||
    ["INTERNAL", "UNAVAILABLE", "DEADLINE_EXCEEDED"].includes(apiStatus ?? "")
  ) {
    return "overloaded";
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return "bad_request";
  }
  return "other";
}

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Finish reasons and block reasons that mean the model declined. */
const REFUSALS = ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"];

async function* streamAnswer(
  model: string,
  apiKey: string | undefined,
  fetcher: FetchLike,
  request: StreamRequest
): AsyncGenerator<ProviderStreamEvent> {
  if (!apiKey) {
    throw new GeminiError(
      undefined,
      "UNAUTHENTICATED",
      "GEMINI_API_KEY is not set"
    );
  }
  const system =
    request.mode === "compare"
      ? COMPARE_SYSTEM_PROMPT
      : STRUCTURED_SYSTEM_PROMPT;
  const prior = historyText(request.history);
  const response = await fetcher(
    `${API_BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      signal: request.signal,
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: `${system}\n\n${PROMPT_CITATION_FORMAT}` }],
        },
        contents: [
          {
            role: "user",
            parts: [
              { text: sourcesText(request) },
              ...(prior ? [{ text: prior }] : []),
              { text: redactSecrets(request.question).text },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
    }
  );
  if (!response.ok || !response.body) {
    throw GeminiError.fromBody(response.status, await jsonOf(response));
  }

  const progress = request.progress;
  let finishReason: string | undefined;
  let refused = false;
  let usage: Usage | null = null;
  let modelText = "";
  // Yields each finished JSON line; checks the signal before every line, since
  // one transport chunk can hold several.
  const lines = function* (final: boolean) {
    const parts = modelText.split("\n");
    modelText = final ? "" : (parts.pop() ?? "");
    for (const line of parts) {
      if (!line.trim()) {
        continue;
      }
      request.signal?.throwIfAborted();
      const block = parsePromptedBlock(line, request.sources);
      // Unplaceable or malformed lines are dropped, never passed on uncited.
      if (block) {
        yield {
          type: "text" as const,
          text: `${block.text}\n`,
          citations: block.citations,
        };
      }
    }
  };

  for await (const chunk of sseData(response.body)) {
    request.onEvent?.();
    if (field(chunk, "error") !== undefined) {
      throw GeminiError.fromBody(undefined, chunk);
    }
    const metadata = field(chunk, "usageMetadata");
    const prompt = numberOf(metadata, "promptTokenCount");
    if (progress && prompt !== undefined) {
      progress.inputTokens = prompt;
    }
    if (field(field(chunk, "promptFeedback"), "blockReason") !== undefined) {
      refused = true;
    }
    const candidate = first(field(chunk, "candidates"));
    for (const part of arrayOf(field(field(candidate, "content"), "parts"))) {
      const text = field(part, "text");
      if (typeof text === "string" && field(part, "thought") !== true) {
        modelText += text;
        if (progress) {
          progress.outputChars += text.length;
        }
      }
    }
    yield* lines(false);
    const reason = field(candidate, "finishReason");
    if (typeof reason === "string") {
      finishReason = reason;
      refused ||= REFUSALS.includes(reason);
      // Usage is final only on the chunk that ends the candidate.
      usage =
        prompt !== undefined
          ? {
              inputTokens: prompt,
              // Thinking tokens are billed as output.
              outputTokens:
                (numberOf(metadata, "candidatesTokenCount") ?? 0) +
                (numberOf(metadata, "thoughtsTokenCount") ?? 0),
            }
          : null;
    }
  }
  modelText += "\n";
  yield* lines(true);
  yield {
    type: "end",
    finishReason: finishReason === "STOP" ? "stop" : "other",
    refused,
    usage,
  };
}

/** The sources as numbered JSON: escaping keeps document text from closing the list. */
function sourcesText(request: StreamRequest): string {
  return `Search results:\n${JSON.stringify(
    request.sources.map((s, i) => ({
      id: i + 1,
      title: redactSecrets(s.document.title || "Untitled").text,
      // Joined as parsePromptedBlock joins them, so quotes spanning sections match.
      content: s.sections.join("\n"),
    }))
  )}`;
}

/** Parsed `data:` payloads of an SSE body; buffers lines split across chunks. */
async function* sseData(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.replace(/\r$/, "");
      if (data.startsWith("data:")) {
        yield parseJson(data.slice(5));
      }
    }
  }
}

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return parseJson(await response.text());
  } catch {
    return undefined;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A property of an untyped JSON value, or undefined. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

function numberOf(value: unknown, key: string): number | undefined {
  const n = field(value, key);
  return typeof n === "number" ? n : undefined;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function first(value: unknown): unknown {
  return arrayOf(value)[0];
}
