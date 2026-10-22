# AI Provider Adapter and Failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI Search keeps answering when one model supplier fails (out of credit, overloaded, rate-limited), and any supplier can be added behind one adapter interface without touching retrieval, the verifier, metering or the UI.

**Architecture:** `plugins/ai-answers` already has a provider-neutral verifier (`verify.ts` only trusts `ProviderCitation` section ranges plus quotes). What is missing is a neutral *streaming* interface: `streamAnswer` and `ProviderStreamEvent` live inside `providers/anthropic.ts` and `ask.ts` calls them directly. We add a `StreamingProvider` interface, a typed error classification per adapter, and a small chain that fails over **only before the first event** is produced. Phase 0 changes no supplier; later phases add adapters, each gated by an eval run and (for new vendors) owner approval of data terms.

**Tech Stack:** TypeScript, Koa, Redis, Vitest, `@anthropic-ai/sdk` (already installed). No new dependency in Phase 0.

**Spec:** research report `scratchpad/reports/LLM provider fallback patterns.md` (not in repo); existing contract `plugins/ai-answers/server/contract.ts`; earlier plans `2026-10-16-m2-execution-plan.md`, `2026-10-18-option-a-fidelity-plan.md`.

## Global Constraints

- Branch `feat/ai-provider-adapter`, worktree `/Users/developer/Projects/outline-adapter`, from `origin/main`. Stop at a PR per phase; no merge or deploy without owner approval. Never edit `/Users/developer/Projects/Outline` (shared checkout).
- Tests only against the isolated DB `outline_ai_m1` (credentials from `.env.test`, never printed, `NODE_ENV=test`, `PGSSLMODE=disable`). Never `.env`, `.env.local`, `.env.production` (they point at production). Run with `npx corepack@0.34.0 yarn test <path>`.
- Owner rule: ZDR eligibility and EU processing terms are **confirmed, never assumed**. No adapter for a new vendor is enabled before the owner approves that vendor's data terms in writing.
- Owner rule: answers stay grounded in authorized documents with verified citations. Every provider's output passes the unchanged `AnswerVerifier`; a weaker provider must produce more withheld answers, never looser checks.
- A model call is billed and metered exactly once per attempt; the Anthropic client keeps `maxRetries: 0` (`anthropicClient.ts`). Retries happen in one place only: the chain.
- Failover only before the first provider event. After the first event an error is shown (`failed`), never resumed or restarted mid-answer.
- Our own aborts (client disconnect, deadline, idle limit) never trigger failover and never trip a circuit breaker.
- No secrets, questions or answers in logs. Alerts log provider id and error kind only.
- CLAUDE.md conventions: curly braces, named exports, JSDoc on exports, no `any`, no casts where avoidable, `interface` for object shapes, early returns, `oxfmt`/`oxlint`/`yarn tsc` clean, explicit `git add` paths, commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (opus tasks: `Claude Opus 5.5`).

## Where to build (Outline vs implexus-kb)

Build **only in Outline** (`tin-wizard/outline`, production TIN KB). `implexus-kb` shares history with it (merge base `0f685ed6a`) but has diverged: it lacks the whole `plugins/ai-answers` plugin (178 commits of AI work are not in it) and has 43 commits of its own (pages-gate etc.). Copying files would lose history and drift. When implexus-kb needs AI Search, bring over merged Outline commits with `git merge`/`git cherry-pick` on a branch there and resolve conflicts once. That is a separate owner decision and is not part of this plan.

## Model routing

| Task | `model` | `subagent_type` | Justification |
|------|---------|-----------------|---------------|
| 1. Neutral streaming interface | `sonnet` | `general-purpose` | Multi-file refactor, behaviour-preserving, existing tests guard it |
| 2. Error classification | `opus` | `general-purpose` | Decides what is retried/failed over; billing and security-adjacent |
| 3. Chain, breaker, config | `opus` | `general-purpose` | Streaming + metering invariants; no existing pattern in repo |
| 4. `ask.ts` wiring, billed model, alert | `opus` | `general-purpose` | Touches metering and the abort/deadline path |
| 5. UI "search instead" action | `sonnet` | `general-purpose` | Small UI change on an existing notice |
| 6. Prompt-citation base + contract suite | `opus` | `general-purpose` | Grounding path; decides how weak citations are accepted |
| 7. Claude on Bedrock/Vertex | `sonnet` (spike: orchestrator) | `general-purpose` | Mostly SDK wiring; live test needs owner credentials, stays with orchestrator |
| 8. Gemini adapter, 9. Mistral adapter | `sonnet` | `general-purpose` | Follow Task 6 base; reviewed by opus |
| 10. Eval gate | `sonnet` | `general-purpose` | Extends existing harness |
| Reviews | `sonnet` / `opus` | `general-purpose` | `opus` for tasks 2, 3, 4, 6, final whole-branch; `sonnet` otherwise |

Before dispatching each task after the first, the orchestrator reads the previous task's diff and tests and writes a Previous Phase Context Review in chat (see model-routing skill).

## Review Focus

Failure modes the spec implies but no single task's happy path covers, most likely first:

1. A provider errors **after** its first text event: the answer must fail cleanly, with no second provider started and no duplicated text. (Task 3 test.)
2. The client disconnects or the deadline fires during an attempt: no failover, no breaker trip, no alert. (Task 3 test.)
3. Every provider is in cooldown: the chain still tries them (last resort) instead of failing forever. (Task 3 test.)
4. The fallback served the answer: the usage row records the **served** model and is priced by it; an unknown model is priced at the most expensive known price. (Task 4 test.)
5. Env lists no valid provider or an unknown id: AI answers fail closed with `unavailable`, never crash or silently use a default. (Task 3 test.)
6. A weak-citation provider invents a quote or a section range: the verifier drops the block. (Task 6 test.)

---

## Phase 0 — resilience with no new supplier (one PR)

### Task 1: Neutral streaming interface

**Files:**
- Modify: `plugins/ai-answers/server/contract.ts` (add types), `plugins/ai-answers/server/providers/anthropic.ts` (export an adapter), `plugins/ai-answers/server/api/ask.ts` (import types from `contract`)
- Create: `plugins/ai-answers/server/providers/registry.ts`
- Test: `plugins/ai-answers/server/providers/anthropic.test.ts` (create; the adapter had no unit test of its own)

**Interfaces:**
- Produces, in `contract.ts` (moved from `providers/anthropic.ts`, same shapes): `ProviderStreamEvent`, `StreamProgress` (add optional `served?: { provider: string; model: string }`), `StreamRequest`.
- Produces, in `contract.ts`:
  ```ts
  export type ProviderErrorKind =
    | "billing" | "rate_limit" | "overloaded" | "network"
    | "auth" | "bad_request" | "other";
  export interface StreamingProvider {
    readonly id: string;
    readonly model: string;
    stream(request: StreamRequest): AsyncGenerator<ProviderStreamEvent>;
    classify(error: Error): ProviderErrorKind;
  }
  ```
- Produces, in `providers/anthropic.ts`: `createAnthropicStreamingProvider(client: AnswerClient, model: string): StreamingProvider` (`id` is `"anthropic"`; `stream` is the existing `streamAnswer` logic with `model` passed in instead of read from `env`; `classify` returns `"other"` until Task 2).
- Produces, in `providers/registry.ts`: `getProviders(): StreamingProvider[]` returning `[createAnthropicStreamingProvider(getClient(), env.AI_ANSWERS_MODEL)]`.

- [ ] **Step 1: Write the failing test** `anthropic.test.ts` › "streams text blocks with citations then an end event": fake `AnswerClient` yielding `message_start`, a text block with one `search_result_location` citation, `message_delta` (stop_reason `end_turn`, output 7). Assert events equal `[{type:"text", text, citations:[{sourceIndex:0, sectionIndex:1, endSectionIndex:2, quote}]}, {type:"end", finishReason:"stop", refused:false, usage:{inputTokens:10, outputTokens:7}}]`. A second test › "passes the configured model to the client": assert the fake's `create` was called with the `model` given to the factory, not `env.AI_ANSWERS_MODEL`.
- [ ] **Step 2: Run** `npx corepack@0.34.0 yarn test plugins/ai-answers/server/providers/anthropic.test.ts`. Expected: FAIL (`createAnthropicStreamingProvider` is not exported).
- [ ] **Step 3: Move the three types into `contract.ts`**, make `providers/anthropic.ts` import them, and add `createAnthropicStreamingProvider` wrapping the existing generator. Keep `streamAnswer` exported only if `ask.test.ts` imports it; otherwise make it module-private.
- [ ] **Step 4: Switch `ask.ts`** (`~line 677`) from `streamAnswer(getClient(), {...})` to `provider.stream({...})` where `provider` is `getProviders()[0]` (single provider; the chain arrives in Task 3). Run the full plugin suite: `npx corepack@0.34.0 yarn test plugins/ai-answers/server`. Expected: all pass, no behaviour change.
- [ ] **Step 5: Run** `yarn tsc` and `yarn lint`. Expected: clean.
- [ ] **Step 6: Commit** `refactor(ai-answers): neutral streaming provider interface`.

### Task 2: Error classification

**Files:**
- Modify: `plugins/ai-answers/server/providers/anthropic.ts` (`classify`)
- Test: `plugins/ai-answers/server/providers/anthropic.test.ts`

**Interfaces:**
- Consumes: `ProviderErrorKind`, `StreamingProvider.classify` (Task 1).
- Produces: `classify(error)` for the Anthropic adapter, as this table (match on message/error code, not status alone):

  | Input | Kind |
  |---|---|
  | HTTP 400 whose message contains `credit balance is too low` (observed in production logs 2026-10-20) | `billing` |
  | HTTP 402; HTTP 429 with `error.details.error_code === "enforced_spend_limit_reached"`; HTTP 400 `invalid_request_error` whose message mentions a spend/usage limit | `billing` |
  | Other HTTP 429 | `rate_limit` |
  | HTTP 529, 500, 502, 503, 504, or an SSE `overloaded_error` | `overloaded` |
  | Connection errors (`APIConnectionError`, `ECONNRESET`, `fetch failed`) | `network` |
  | HTTP 401, 403 | `auth` |
  | Any other 4xx (e.g. 400, 413, 422) | `bad_request` |
  | Anything else | `other` |

- [ ] **Step 1: Write the failing tests**, one per table row, using `Anthropic.APIError`-shaped objects (status, `error` body). Include the exact production message: `400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}` → `billing`. Include "plain 400 invalid request is `bad_request`, not `billing`".
- [ ] **Step 2: Run the file.** Expected: FAIL.
- [ ] **Step 3: Implement `classify`** as a pure function `classifyAnthropicError(error: Error): ProviderErrorKind` in `providers/anthropic.ts`, and return it from the adapter.
- [ ] **Step 4: Run the file, `yarn tsc`, `yarn lint`.** Expected: pass.
- [ ] **Step 5: Commit** `feat(ai-answers): classify Anthropic errors by kind`.

### Task 3: Failover chain, circuit breaker, provider config

**Files:**
- Create: `plugins/ai-answers/server/providers/chain.ts`, `plugins/ai-answers/server/providers/health.ts`
- Modify: `plugins/ai-answers/server/providers/registry.ts`, `plugins/ai-answers/server/env.ts`, `.env.sample`
- Test: `plugins/ai-answers/server/providers/chain.test.ts`, `plugins/ai-answers/server/providers/registry.test.ts`

**Interfaces:**
- Consumes: `StreamingProvider`, `ProviderErrorKind`, `StreamRequest`, `StreamProgress.served` (Task 1), `classify` (Task 2).
- Produces, `health.ts`:
  ```ts
  export interface ProviderHealth {
    isOpen(id: string): boolean;
    trip(id: string, kind: ProviderErrorKind): void;
  }
  export const defaultHealth: ProviderHealth;            // in-process Map<string, number>
  export const COOLDOWN_MS: Record<"billing"|"auth", number>
    & Record<"rate_limit"|"overloaded"|"network", number>; // billing/auth 600_000, others 30_000
  ```
  `// shortcut: per-process state, so each web instance learns separately; move to Redis if we run many instances.`
- Produces, `chain.ts`:
  ```ts
  export const FIRST_EVENT_TIMEOUT_MS = 8_000;           // judgement; no source gave a value
  export class AllProvidersFailedError extends Error {
    attempts: { provider: string; kind: ProviderErrorKind }[];
  }
  export async function* streamWithFallback(
    providers: StreamingProvider[],
    request: StreamRequest,
    health?: ProviderHealth
  ): AsyncGenerator<ProviderStreamEvent>;
  ```
  Behaviour: iterate providers in order, skipping those where `health.isOpen` (if all are open, try them all anyway). Set `request.progress.served = {provider: id, model}` when an attempt starts. Run each attempt under an `AbortSignal` that is `request.signal` combined with `FIRST_EVENT_TIMEOUT_MS` until the first event arrives (the timeout aborts only that attempt and counts as `network`). If an attempt throws before yielding: when `request.signal.aborted` rethrow immediately (no trip, no failover); otherwise `kind = provider.classify(error)`; `bad_request` and `other` rethrow immediately (a different provider would fail the same way); `billing|rate_limit|overloaded|network|auth` call `health.trip` (and `alertProviderDown` for `billing|auth`, Task 4) and continue to the next provider. If an attempt throws after yielding, rethrow. When every provider failed with those kinds, throw `AllProvidersFailedError` **even when only one provider is configured** (so today's single-provider credit outage reaches the user as `unavailable`, not the generic error); `bad_request`, `other` and post-event errors always rethrow the original error. The first-event timeout applies only while more than one provider remains untried (a lone provider keeps today's idle-limit behaviour).
- Produces, `registry.ts`: `parseProviderSpec(spec: string | undefined, defaultModel: string): { id: string; model: string }[]` (comma list of `id:model`; default `anthropic:<defaultModel>`; unknown ids are dropped with `Logger.warn`), and `getProviders()` now builds from `env.AI_ANSWERS_PROVIDERS`; returns `[]` when none valid.
- Produces, `env.ts`: `AI_ANSWERS_PROVIDERS` optional string, same style as `AI_ANSWERS_MODEL`. `AI_ANSWERS_ENABLED` is unchanged in this phase.

- [ ] **Step 1: Write the failing chain tests** with fake providers (async generators that throw or yield) and a fake `ProviderHealth`:
  1. "falls over to the second provider when the first throws billing before any event": events come from provider B; `progress.served` is B; A is tripped with `billing`.
  2. "does not fall over after the first event": A yields one text event then throws `overloaded` → generator rethrows, B never called. (Review Focus 1)
  3. "does not fall over on bad_request": A throws `bad_request` → rethrown, B never called.
  4. "an aborted request is not failed over and not tripped": abort `request.signal` then A throws → rethrown, `trip` not called, B not called. (Review Focus 2)
  5. "tries open providers when all are open". (Review Focus 3)
  6. "a provider silent for FIRST_EVENT_TIMEOUT_MS is failed over" using fake timers.
  7. "a lone provider failing with billing throws AllProvidersFailedError with one attempt"; "a lone provider failing with bad_request rethrows the original error"; "several providers all failing throws AllProvidersFailedError with attempts in order"; "a lone provider is not subject to FIRST_EVENT_TIMEOUT_MS".
- [ ] **Step 2: Write the failing registry tests:** default spec → one anthropic provider with `AI_ANSWERS_MODEL`; `anthropic:claude-haiku-5-5,anthropic:claude-sonnet-5-5` → two; unknown id dropped; `""`/only-unknown → `[]` (Review Focus 5).
- [ ] **Step 3: Run both files.** Expected: FAIL.
- [ ] **Step 4: Implement** `health.ts`, `chain.ts`, `registry.ts`, `env.ts` and the `.env.sample` line `# AI_ANSWERS_PROVIDERS=anthropic:claude-haiku-5-5` with a comment that the order is the failover order.
- [ ] **Step 5: Run both files, `yarn tsc`, `yarn lint`.** Expected: pass.
- [ ] **Step 6: Commit** `feat(ai-answers): provider failover chain with circuit breaker`.

### Task 4: Wire the chain into `ask.ts`, bill the served model, alert

**Files:**
- Modify: `plugins/ai-answers/server/api/ask.ts` (`~lines 562 and 677`), `plugins/ai-answers/server/providers/health.ts`, `plugins/ai-answers/server/providers/chain.ts` (call `alertProviderDown`)
- Test: `plugins/ai-answers/server/api/ask.test.ts`, `plugins/ai-answers/server/providers/health.test.ts`

**Interfaces:**
- Consumes: `streamWithFallback`, `getProviders`, `AllProvidersFailedError` (Task 3); `StreamProgress.served`.
- Produces, `health.ts`: `alertProviderDown(provider: string, kind: ProviderErrorKind): Promise<void>`. Sets Redis key `ai-answers:provider-alert:<provider>:<kind>` with NX and a 3600 s expiry (same pattern as `checkBudgetAlerts` in `usage.ts`); when newly set, `Logger.error("AI answers provider unavailable", { provider, kind })`. Never throws, never delays the answer (call with `void`). `chain.ts` calls it for `billing` and `auth` trips.

- [ ] **Step 1: Write the failing tests** in `ask.test.ts` (mock `getProviders`):
  1. "bills the model that served the answer": primary throws `billing`, secondary (`model: "claude-haiku-5-5"`) answers → usage row `model` is the secondary's model and `costMicroUsd` uses its price. (Review Focus 4)
  2. "no provider configured → `failed` reason `unavailable`, no model call, no usage row".
  3. "all providers fail → `failed` reason `unavailable`" (not the generic `error`) when every attempt was `billing|rate_limit|overloaded|network|auth`.
  And in `health.test.ts`: "alerts once per hour per provider and kind".
- [ ] **Step 2: Run the two files.** Expected: FAIL.
- [ ] **Step 3: Implement.** In `ask.ts` replace `provider.stream(...)` with `streamWithFallback(getProviders(), {...})`; use `progress.served?.model ?? env.AI_ANSWERS_MODEL` where the usage entry sets `model`; map `AllProvidersFailedError` and the no-provider case to `finish([], { failed: "unavailable" })`, keeping every other error on the existing `error` path. Add `alertProviderDown`.
- [ ] **Step 4: Run the plugin suite** `npx corepack@0.34.0 yarn test plugins/ai-answers/server`, then `yarn tsc`, `yarn lint`. Expected: pass.
- [ ] **Step 5: Commit** `feat(ai-answers): fail over between providers and bill the served model`.

### Task 5: "Search documents instead" on the unavailable notice

> **Dropped (ruling 2026-10-22):** already implemented. `ProblemNotice.tsx:85-88` renders "Search instead" (`searchPath({ query })`) for the `unavailable` problem, tested at `Notices.test.tsx:95` and `:246`. No code needed; the steps below are kept for the record.

**Files:**
- Modify: `app/scenes/AISearch/ProblemNotice.tsx` (`case "unavailable"` near line 182)
- Test: `app/scenes/AISearch/Notices.test.tsx` (the `"unavailable"` row near line 139)

**Interfaces:**
- Consumes: the existing `unavailable` failure reason (unchanged on the wire).
- Produces: the `unavailable` notice also renders a link to the normal search page for the same query (use the existing `searchPath` helper in `app/utils/routeHelpers`).

- [ ] **Step 1: Write the failing test:** the `unavailable` notice contains a link whose `href` is the search path for the asked question.
- [ ] **Step 2: Run** `npx corepack@0.34.0 yarn test app/scenes/AISearch/Notices.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the link with a `t()` string (no manual translation JSON edits). Keep the existing message.
- [ ] **Step 4: Run the file, `yarn tsc`, `yarn lint`.** Expected: pass.
- [ ] **Step 5: Commit** `feat(ai-search): offer document search when AI is unavailable`.

**Phase 0 exit:** open one PR for Tasks 1–5. Owner steps outside the code: turn on Anthropic auto-reload and a low-balance email in the Console; production keeps `AI_ANSWERS_PROVIDERS` unset (behaviour unchanged) until a second provider exists.

---

## Phase 1 — same Claude model on a second supplier (owner-gated)

### Task 6: Prompt-citation base and adapter contract suite

**Files:**
- Create: `plugins/ai-answers/server/providers/promptCitations.ts`, `plugins/ai-answers/server/providers/contractSuite.ts`
- Test: `plugins/ai-answers/server/providers/promptCitations.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** Instructions appended for providers without native citations. */
  export const PROMPT_CITATION_FORMAT: string;
  /** Parses one JSON line {"text": string, "cites": [{"id": number, "quote": string}]} into an event. */
  export function parsePromptedBlock(
    line: string, sources: AnswerSource[]
  ): { text: string; citations: ProviderCitation[] } | null;
  /** Shared tests every StreamingProvider must pass; adapters call it with a fake transport. */
  export function describeProviderContract(
    name: string, make: (script: FakeScript) => StreamingProvider
  ): void;
  ```
  `parsePromptedBlock` maps `id` to `sourceIndex` and finds the section range whose text contains `quote`; no match → `null` (the block is dropped later by the verifier; it is never repaired).
- The contract suite asserts: text events precede one `end`; `usage` is `null` when the transport never reports it; the abort signal stops the stream; an invented quote or an out-of-range `id` yields a block the real `AnswerVerifier` withholds (Review Focus 6); `classify` returns `billing` for the vendor's credit-exhausted fixture.

- [ ] **Step 1: Write failing tests** for `parsePromptedBlock` (valid; quote not in any section → `null`; `id` out of range → `null`; multi-section quote → correct `endSectionIndex`) and run the contract suite against a fake adapter built on it.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the three exports. Reuse `normalizeForMatch`-style text helpers from `text.ts` if present; do not add a dependency.
- [ ] **Step 4: Run, `yarn tsc`, `yarn lint`.** Expected: pass. **Step 5: Commit** `feat(ai-answers): prompt-citation base and adapter contract suite`.

### Task 7: Claude via Bedrock or Vertex (OWNER-GATED)

**Gate:** owner provides a separate cloud account and credits, and confirms in writing the retention/EU terms of the chosen route (cloud provider is the data processor; Anthropic's ZDR programme does not apply there). The orchestrator, not a subagent, runs the live test with credentials entered through the hidden terminal prompt.

**Files:**
- Create: `plugins/ai-answers/server/providers/anthropicCloud.ts`, `plugins/ai-answers/server/providers/anthropicCloud.test.ts`
- Modify: `plugins/ai-answers/server/providers/registry.ts`, `package.json` (only the official Anthropic cloud client for the chosen route, if the installed SDK does not already include it)

**Interfaces:**
- Produces: `createAnthropicCloudProvider(route: "bedrock" | "vertex", model: string): StreamingProvider` reusing the Anthropic stream mapping from Task 1 and the Task 2 classifier (the SDK error shapes match).

- [ ] **Step 1 (spike, orchestrator): live test.** With one metered call, confirm `search_result` blocks with citations return `search_result_location` citations on the chosen route. Record result in the PR. If not supported, stop and re-plan this task; the research sources disagreed on this point.
- [ ] **Step 2: Write failing tests** with `describeProviderContract` plus a case that the model id and region come from `AI_ANSWERS_PROVIDERS` entries like `bedrock:<model-id>`.
- [ ] **Step 3: Implement** the adapter and register id `bedrock`/`vertex`; make `AI_ANSWERS_ENABLED` true when any registered provider has credentials.
- [ ] **Step 4: Run the plugin suite, `yarn tsc`, `yarn lint`.** **Step 5: Commit** `feat(ai-answers): Claude on a second cloud supplier`.

---

## Phase 2 — other model families (owner-gated, each behind an eval gate)

### Task 8: Gemini adapter, Task 9: Mistral adapter (OWNER-GATED)

**Gate (each):** owner approves that vendor's data terms in writing (ZDR, training use, EU processing); an API key is entered through the hidden terminal prompt; Task 10's gate passes. Citations are prompted (`PROMPT_CITATION_FORMAT` from Task 6) because Gemini's documented grounding covers only Google Search/URL context and Mistral returns reference ids without offsets.

**Files (per vendor):** Create `plugins/ai-answers/server/providers/<vendor>.ts` and `<vendor>.test.ts`; modify `registry.ts`, `pricing.ts` (add the vendor model's price from its published page, cited in the commit), `env.ts`/`.env.sample` (the vendor key).

**Interfaces:**
- Produces: `create<Vendor>Provider(model: string): StreamingProvider`; its `classify` maps that vendor's credit-exhausted, rate-limit, overload, auth and bad-request responses per its documented error codes.

- [ ] **Step 1: Write failing tests** with `describeProviderContract` and the vendor's recorded error fixtures.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the adapter using the vendor's official SDK or plain `fetch` streaming (no gateway dependency).
- [ ] **Step 4: Run the plugin suite, `yarn tsc`, `yarn lint`.** **Step 5: Commit** `feat(ai-answers): <vendor> provider`.

### Task 10: Eval gate for any provider

**Files:**
- Modify: `plugins/ai-answers/eval/run.mjs`, `plugins/ai-answers/eval/score.ts`, `plugins/ai-answers/eval/live.test.ts`
- Test: `plugins/ai-answers/eval/score.test.ts`

**Interfaces:**
- Produces: `run.mjs --provider <id:model>` runs `cases.json` through that provider and reports, per provider: answered rate, citations valid, dropped statements per answer, refusal-when-not-covered rate, median latency, cost per answer. `score.ts` exports `passesGate(result, baseline): boolean`; thresholds are set by the owner after the first baseline run (no numbers are invented here).

- [ ] **Step 1: Write the failing test** `passesGate` › "fails a provider whose valid-citation rate is below the baseline" and "fails a provider that answers a not-covered case".
- [ ] **Step 2: Run** `npx corepack@0.34.0 yarn test plugins/ai-answers/eval/score.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `--provider` and `passesGate`. The live run needs a key entered through the hidden terminal prompt and spends real money: ask the owner before running it.
- [ ] **Step 4: Run the test file, `yarn tsc`, `yarn lint`.** **Step 5: Commit** `feat(ai-answers): per-provider eval gate`.

## Out of scope (named so nobody builds them by accident)

A gateway sidecar (LiteLLM, Portkey); Redis-shared breaker state; a model picker; the "Answered by <model>" label; mid-stream resume; automatic provider ordering by cost or latency. Add each only when a real need appears.

## Self-review notes

- Spec coverage: every recommendation in the report maps to a task (error taxonomy → 2; failover rule, breaker, one retry layer → 3; alerting and served-model billing → 4; graceful degradation → 5; neutral citations and weak-provider handling → 6; same-model second supplier → 7; other families and eval gate → 8–10).
- Open, unverified items carried from the report: `search_result` support on Bedrock/Vertex (Task 7 step 1 settles it); the exact HTTP shape of credit exhaustion on non-Anthropic vendors; whether the configured model falls under Anthropic's 30-day-retention exception.
- Numbers marked "judgement" (`FIRST_EVENT_TIMEOUT_MS`, cooldowns) have no source and should be tuned from production logs.
