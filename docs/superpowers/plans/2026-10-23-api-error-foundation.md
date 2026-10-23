# API Error Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a request fails anywhere in the app, the person sees what happened and what to do next, in plain translated words, and never raw server text for server faults. This first pass fixes the shared foundation and the worst confusing screens; a sweep of every toast is a later PR.

**Architecture:** (1) `app/utils/ApiClient.ts` `toError` keeps the existing error classes (every `instanceof` in the app keeps working) but makes them carry `status`, `id`, `retryAfter` and `data`, gives 401 a message, maps 5xx/409/413 to plain text, and stops embedding the gateway body in the 502 message. (2) One new module `app/utils/describeError.ts` turns any caught error into `{ title, hint?, retryable }` copy and refuses to emit `err.message` for server faults or unknown errors. (3) The priority screens use it: silent email sign-in failure, search failure, collection and document load failures.

**Tech Stack:** TypeScript, React, MobX, i18next (`t()`), Vitest.

**Spec:** owner request 2026-10-23 ("make sure in the whole system, if there is any error, the right error message shows up"); audit `scratchpad/error-audit/platform-error-audit.md` (not in repo), items 1, 2, 4, 5, 8 and section 5.

## Global Constraints

- Branch `feat/api-error-foundation`, worktree `/Users/developer/Projects/outline-apierrors`, from `origin/main`. Stop at a PR; no merge/deploy without owner approval. Never edit `/Users/developer/Projects/Outline`.
- Tests only via `/private/tmp/claude-501/-Users-developer-Projects-Outline/92427aa3-eb09-48c1-adbf-cc90bc684578/scratchpad/isodb-apierrors.sh npx corepack@0.34.0 yarn test <path>`; never `.env`, `.env.local`, `.env.production`; never print credentials. Homebrew `node` may be broken (missing libsimdjson): if `node --version` fails, use the node shim in the scratchpad dir and run `node_modules/.bin/vitest|tsc|oxlint|oxfmt` directly through the wrapper (see `/Users/developer/Projects/outline-errors/.superpowers/sdd/2026-10-23-ai-error-messages/task-2-report.md`), and say so.
- Never rename or remove an exported error class in `app/utils/errors.ts`; only add fields or a shared base. Every existing `instanceof` check must keep working.
- Never show `err.message` for 5xx, for non-ApiClient errors, or for unknown errors. For 4xx the server message may still be shown (as today). Never put a gateway/upstream body in an error message (log it only).
- UI copy goes through `t()` (or `i18next.t` outside components, precedent `app/scenes/ApiKeyNew/utils.ts`); do not edit translation JSON. Do not claim anything the system cannot guarantee (for example "an admin has been notified").
- CLAUDE.md conventions: curly braces, named exports, JSDoc on exports, no `any`, avoid casts, `interface` for object shapes, early returns, `handle*` handlers; oxfmt/oxlint/`yarn tsc` clean; explicit `git add`; commit trailer per model (`Claude Opus 5.5` for opus tasks, `Claude Sonnet 5.5` for sonnet tasks).

## Review Focus

1. A 500/502/504 never leaks upstream text, an API path or a stack into any visible message; the gateway body is only logged.
2. Existing tests that assert `"Error 500"` or the old rate-limit text keep their intent (update the strings, not the meaning); every `instanceof` branch still matches (batched sub-requests go through the same `toError`, `ApiClient.ts` ~line 546).
3. `describeError` on `null`, a string, a plain object, a non-Error rejection, or an `AbortError` never throws and returns the generic copy.
4. `retryAfter` from a `Retry-After` header that is missing, non-numeric, zero or huge falls back to "a moment" and never shows "NaN" or a negative number.
5. A load failure that is not a 404 never renders the "not found, might have been deleted" page.

## Model routing

| Task | `model` | `subagent_type` | Justification |
|------|---------|-----------------|---------------|
| 1. ApiClient + error classes | `opus` | `general-purpose` | Every API call in the app flows through it; no-leak rule |
| 2. `describeError` module | `sonnet` | `general-purpose` | Pure function with a fixed copy table |
| 3. Priority screens | `sonnet` | `general-purpose` | Four small, existing-pattern UI edits using Task 2 |
| Reviews | controller | — | Auto-mode classifier blocks reviewer launches; disclose in the PR |

---

### Task 1: ApiClient carries real error facts and plain fallbacks

**Files:**
- Modify: `app/utils/errors.ts`, `app/utils/ApiClient.ts` (`toError` ~lines 331-395, the 502 branch ~277-300, the response header read for `Retry-After`, the batched sub-request path ~546)
- Test: `app/utils/ApiClient.test.ts` (extend or create next to the file), `app/utils/errors.test.ts` if useful

**Interfaces:**
- Produces, in `errors.ts` (exported at the top):
  ```ts
  /** Facts about a failed API request; all optional. */
  export interface ApiErrorDetails {
    status?: number;
    /** The server's error id, e.g. "rate_limit_exceeded". */
    id?: string;
    /** Seconds to wait before retrying, from `Retry-After`. */
    retryAfter?: number;
    data?: Record<string, unknown>;
  }
  /** Base of errors thrown for a failed API request. */
  export class ApiError extends ExtendableError implements ApiErrorDetails { ... }
  ```
  `AuthorizationError, BadRequestError, NotFoundError, PaymentRequiredError, ServiceUnavailableError, BadGatewayError, UnprocessableEntityError, RateLimitExceededError, ClientClosedRequestError, RequestError, UpdateRequiredError` extend `ApiError` (still `ExtendableError` underneath, names unchanged); `NetworkError` and `OfflineError` stay as they are.
- Produces: `toError(status, code, message, extras?: { retryAfter?: number; data?: Record<string, unknown> })` returns errors with `status`, `id` (the `code`) and the extras set.
- Messages (exact English, via `i18next.t`): 401 → "Your session has expired. Sign in again."; 409 → "This changed since you opened it. Reload and try again."; 413 → "That file is too large."; 500/502/503-without-server-message/504 → "Something went wrong on our side. Try again in a moment."; 408 → "That took too long. Try again."; any other unmapped status → "Something went wrong (code {{status}}). Try again."; 429 → "Too many requests. Try again in {{seconds}} seconds." when `retryAfter` is a positive integer ≤ 3600, else "Too many requests. Try again in a moment.". 4xx with a server message keep that message. The 502 message is the 5xx text above (the path and upstream body go only to `Logger.error`, already there).

- [ ] **Step 1: Write the failing tests** (mock `fetch`; follow any existing ApiClient test setup): each status above produces the exact message and class (`status === 401` → `AuthorizationError` with the 401 text, 500 → `RequestError` with the 5xx text and `status: 500`, 502 → `BadGatewayError` whose message contains no path and no upstream body, 409, 413, 408, 418 → "(code 418)"); `id` from the JSON `error` field; `Retry-After: "30"` → `retryAfter: 30` and the 30-second text; `Retry-After` missing/`"abc"`/`"0"`/`"-5"`/`"999999"` → the "in a moment" text (Review Focus 4); a 404 with a server message keeps it; `instanceof` for every mapped class still holds; a batched sub-request error gets the same mapping.
- [ ] **Step 2: Run** `.../isodb-apierrors.sh npx corepack@0.34.0 yarn test app/utils/ApiClient.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `ApiError`, re-base the classes, extend `toError` and read `Retry-After` from the response headers where `toError` is called (and for batched results if the headers are available there; otherwise leave `retryAfter` undefined). Keep the `Logger.error` for unmapped statuses.
- [ ] **Step 4: Run** the ApiClient tests, then every test file that mentions the old strings (`grep -rn "Error 500\|Too many requests\|Bad gateway response" app shared --include=*.test.*`), then `yarn tsc` and lint/format on changed files. Fix test strings only where the old text was asserted. Expected: pass.
- [ ] **Step 5: Commit** `feat(app): API errors carry status, id and retry-after with plain fallbacks`.

### Task 2: `describeError`

**Files:**
- Create: `app/utils/describeError.ts`, `app/utils/describeError.test.ts`

**Interfaces:**
- Consumes: `ApiError` and subclasses, `OfflineError`, `NetworkError` from Task 1 / `errors.ts`.
- Produces:
  ```ts
  export interface ErrorDescription { title: string; hint?: string; retryable: boolean }
  /** Plain-language copy for a caught error; never throws, never emits `message` of a server fault. */
  export function describeError(t: TFunction, err: unknown): ErrorDescription;
  ```
  (use the repo's existing `TFunction`/`Translate` type as other helpers do, e.g. in `ProblemNotice.tsx`).

  Copy (exact strings):

  | Input | title | hint | retryable |
  |---|---|---|---|
  | `OfflineError`, `NetworkError`, `TypeError("Failed to fetch")`-like, or `navigator.onLine === false` | "You're offline." | "Check your connection and try again." | true |
  | `AuthorizationError` with `status === 401` | "Your session has expired." | "Sign in again." | false |
  | other `AuthorizationError` | "You don't have permission to do that." | "Ask an admin for access." | false |
  | `NotFoundError` | "That couldn't be found." | "It may have been deleted or moved." | false |
  | `RateLimitExceededError` | "Too many requests." | `retryAfter` → "Try again in {{seconds}} seconds." else "Try again in a moment." | true |
  | `status === 409` | "This changed since you opened it." | "Reload and try again." | true |
  | `status === 413` | "That file is too large." | none | false |
  | `PaymentRequiredError` | server message if present, else "This isn't available on your plan." | none | false |
  | `BadRequestError`, `UnprocessableEntityError` | server message if present, else "That request wasn't valid." | none | false |
  | `UpdateRequiredError` | "A newer version of the app is needed." | "Reload the page." | true |
  | `ClientClosedRequestError`, `AbortError` | "The request was cancelled." | none | true |
  | any `ApiError` with `status >= 500`, `RequestError`, `ServiceUnavailableError`, `BadGatewayError` | "Something went wrong on our side." | "Try again in a moment." | true |
  | anything else (string, null, plain object, unknown Error) | "Something went wrong." | "Try again. If it keeps happening, tell an admin." | true |

- [ ] **Step 1: Write the failing tests**: one test per row with the exact strings; the "never emits message" rule: a `RequestError("secret upstream text")` and a plain `Error("secret")` never appear in any returned string; `describeError(t, null)`, a string, `{}`, `undefined` return the generic row without throwing (Review Focus 3); `retryAfter` of 0, NaN, `-1`, `99999` fall to "Try again in a moment.".
- [ ] **Step 2: Run** `.../isodb-apierrors.sh npx corepack@0.34.0 yarn test app/utils/describeError.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as a pure function; classify by `instanceof` then by `status`; clamp `retryAfter` to a positive integer ≤ 3600.
- [ ] **Step 4: Run** the test file, `yarn tsc`, lint/format on the two files. Expected: pass.
- [ ] **Step 5: Commit** `feat(app): describeError turns caught errors into plain copy`.

### Task 3: Priority screens use it

**Files:**
- Modify: `app/scenes/Login/components/AuthenticationProvider.tsx` (email submit catch ~lines 59-61, currently silent), `app/scenes/Search/Search.tsx` (~409) and `app/components/List/Error.tsx` (~34), `app/scenes/Collection/index.tsx` (~136), `app/components/DataLoader.tsx` (~284) (or the actual file names found by `grep`; the audit's line numbers are approximate)
- Test: the nearest existing test file for each (create small ones where none exist)

**Interfaces:**
- Consumes: `describeError(t, err): ErrorDescription` (Task 2).
- Produces: no new exports; behaviours below.

- [ ] **Step 1: Write the failing tests**: (a) email sign-in: a rejected submit renders the described title and hint in a visible notice above the form (use the existing `Notice` component), clears when the user edits or retries, and a 429 shows the wait time; (b) search: an error with `OfflineError` shows "You're offline."; a rate-limit shows the wait; other errors show the generic copy plus a Retry button that re-runs the search; (c) collection load: a `NotFoundError` still renders the 404 page, any other error renders `ErrorUnknown` (or `ErrorOffline` when offline) with a "Try again" action that re-fetches — never the "might have been deleted" page (Review Focus 5); (d) document load (`DataLoader`): same rule, with retry.
- [ ] **Step 2: Run** the affected test files. Expected: FAIL.
- [ ] **Step 3: Implement** minimal edits using `describeError`; reuse existing components (`Notice`, `ErrorUnknown`, `ErrorOffline`, the existing retry wording such as "Click to retry"). Do not restructure the screens.
- [ ] **Step 4: Run** `app/scenes/Login app/scenes/Search app/scenes/Collection app/components`-scoped tests that exist for the touched files, then `yarn tsc`, lint/format on changed files. Expected: pass.
- [ ] **Step 5: Commit** `feat(app): show the real reason when sign-in, search or loading fails`.

## Out of scope (named so nobody builds them by accident)

The login `description` notice and session-expired notice (server redirects need a safe whitelist); the sweep of the other ~140 toasts; validation wording and import/export stored messages (server-side, leak-sensitive); the editor connection chip on phones; GitHub OAuth unknown errors; upload failure reasons. These are follow-up PRs from the audit.
