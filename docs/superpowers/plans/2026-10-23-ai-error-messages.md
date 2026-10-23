# AI Search Error Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When AI Search cannot answer because every AI provider failed, the person sees the real, actionable reason (credit exhausted, key rejected, service busy, not configured) in plain words, worded by role: admins get what to do, members get what is happening.

**Architecture:** `ask.ts` already classifies provider failures (`AllProvidersFailedError.attempts[].kind`, `ProviderErrorKind`) and sends `failed` with reason `unavailable`. We add a `cause` and the failing `provider` id to the existing `AskFailureDetail` (the channel that already carries `resetsAt`), keep it on the wire type in `streamFetch.ts` and the turn model, and render role-specific copy in `ProblemNotice.tsx`. Nothing sensitive crosses the wire: only a cause enum and a provider id.

**Tech Stack:** TypeScript, Koa SSE, React/MobX, styled-components, Vitest.

**Spec:** owner request 2026-10-23: "when there is no credit … it should give us the right message so that people don't have to guess"; broader platform-wide error-message audit is a separate effort (not in this plan).

## Global Constraints

- Branch `feat/ai-error-messages`, worktree `/Users/developer/Projects/outline-errors`, from `origin/main`. Stop at a PR; no merge/deploy without owner approval. Never edit `/Users/developer/Projects/Outline`.
- Tests only against the isolated DB `outline_ai_m1` via `/private/tmp/claude-501/-Users-developer-Projects-Outline/92427aa3-eb09-48c1-adbf-cc90bc684578/scratchpad/isodb-errors.sh npx corepack@0.34.0 yarn test <path>`; never `.env`, `.env.local`, `.env.production`. Never print credentials. Homebrew `node` may be broken (missing libsimdjson): if `node --version` fails, use the same direct-vitest/shim method earlier agents used and say so in the report.
- Never put vendor error text, keys, amounts, document or question content in the `failed` event or in logs. Only `cause` (enum) and `provider` (id string).
- Failure semantics unchanged: reason stays `"unavailable"`, failover rules, billing/usage rules (zero usage for HTTP-level rejections) untouched.
- UI copy goes through `t()`; do not edit translation JSON. Keep the existing "Search instead" action on every unavailable variant.
- CLAUDE.md conventions: curly braces, named exports, JSDoc on exports, no `any`, avoid casts, `interface` for object shapes, early returns, `handle*` handlers; oxfmt/oxlint/`yarn tsc` clean; explicit `git add`; commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (sonnet tasks: `Claude Sonnet 5.5`).

## Review Focus

1. A mixed failure (one provider out of credit, another rate-limited): the most actionable cause wins (`billing` > `auth` > `rate_limit` > `overloaded` > `network`); it must never show a cause nobody hit.
2. A stored/resumed failed turn has no cause: it must render the existing generic unavailable copy, never crash or show an empty message.
3. A member must never see vendor names or the how-to-fix text; only admins do. An unknown provider id renders as "the AI provider".
4. `not_configured` (no valid provider) is distinct from a provider failure and tells admins what to check.

## Model routing

| Task | `model` | `subagent_type` | Justification |
|------|---------|-----------------|---------------|
| 1. Server: send cause and provider | `opus` | `general-purpose` | Touches `ask.ts` failure path next to metering |
| 2. Client: role-specific copy | `sonnet` | `general-purpose` | Small UI change on an existing notice; copy fixed here |
| Reviews | controller | — | Auto-mode classifier blocks reviewer launches; disclose in the PR |

---

### Task 1: Server sends `cause` and `provider`

**Files:**
- Modify: `plugins/ai-answers/server/api/ask.ts` (`AskFailureDetail`, the stream-failure catch around the `AllProvidersFailedError` mapping, and the no-provider early return)
- Modify: `app/utils/streamFetch.ts` (the wire type of the `failed` event's `detail`)
- Test: `plugins/ai-answers/server/api/ask.test.ts`

**Interfaces:**
- Produces, in `ask.ts` (exported at the top with the other types):
  ```ts
  /** Why AI answers are unavailable, for the person's explanation. */
  export type UnavailableCause =
    | "billing" | "auth" | "rate_limit" | "overloaded" | "network" | "not_configured";
  export interface AskFailureDetail {
    resetsAt?: string;
    /** For `unavailable`: why. */
    cause?: UnavailableCause;
    /** For `unavailable`: the id of the provider that failed (e.g. "anthropic"); never a message. */
    provider?: string;
  }
  ```
- Produces: `unavailableDetail(error: AllProvidersFailedError): AskFailureDetail` (exported pure helper in `ask.ts` or a tiny sibling file): picks the cause by precedence `billing > auth > rate_limit > overloaded > network` across `error.attempts`, and `provider` is the provider id of the first attempt that had that cause.

- [ ] **Step 1: Write the failing tests** in `ask.test.ts`: (a) a provider throwing a billing-class error yields `failed` with `reason: "unavailable"` and `detail: { cause: "billing", provider: "anthropic" }` (use the existing fake-provider pattern in this file); (b) auth and rate_limit likewise; (c) `unavailableDetail` with attempts `[rate_limit(google), billing(anthropic)]` returns `{ cause: "billing", provider: "anthropic" }` (Review Focus 1); (d) no provider configured yields `detail: { cause: "not_configured" }` and no `provider` key; (e) the event payload contains no key besides `reason`, `partial`, `detail` and `detail` contains no key besides `cause`/`provider`/`resetsAt` (no vendor text).
- [ ] **Step 2: Run** `.../isodb-errors.sh npx corepack@0.34.0 yarn test plugins/ai-answers/server/api/ask.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the type, `unavailableDetail`, and pass `detail` through `finish([], { failed: "unavailable", detail })` in both places. Update the `failed` event type in `streamFetch.ts` to accept `detail?: { resetsAt?: string; cause?: ...; provider?: string }` (keep it a plain structural type; do not import server code into the client).
- [ ] **Step 4: Run** the ask test file, then the whole `plugins/ai-answers/server` suite once, `yarn tsc`, and lint on changed files. Expected: pass.
- [ ] **Step 5: Commit** `feat(ai-answers): tell the client why AI answers are unavailable`.

### Task 2: Client shows role-specific messages

**Files:**
- Modify: `app/scenes/AISearch/model.ts` (keep `cause` and `provider` on the failed turn next to `resetsAt`, parsed defensively like `cleanDate`: unknown values are dropped), `app/scenes/AISearch/ProblemNotice.tsx` (`case "unavailable"`)
- Test: `app/scenes/AISearch/Notices.test.tsx`, `app/scenes/AISearch/model.test.ts` (extend if it exists, else the nearest existing reducer test)

**Interfaces:**
- Consumes: `failed.detail.cause` / `.provider` from Task 1.
- Produces: `unavailableCopy(cause: string | undefined, provider: string | undefined, isAdmin: boolean): { title: string; body?: string }` (exported pure function in `ProblemNotice.tsx` or `unavailableCopy.ts`, takes the `t` function as its first argument if the repo's pattern requires it) returning exactly this copy. Provider display names: `anthropic` → "Anthropic", `google` → "Google Gemini", anything else or missing → "the AI provider".

  | cause | member title / body | admin title / body |
  |---|---|---|
  | `billing` | "AI answers are paused because the AI credit has run out." / "An admin has been notified. Search still works for every document." | "The {provider} credit has run out." / "Add credit in the {provider} console (Plans & Billing) and AI answers will resume." |
  | `auth` | "AI answers are temporarily unavailable." / "An admin has been notified." | "The {provider} API key was rejected." / "Check the API key in the server settings." |
  | `rate_limit`, `overloaded`, `network` | "The AI service is busy right now." / "Try again in a minute." | same title and body, plus the cause in the body: "({provider} reported: rate limit | overloaded | could not be reached)". |
  | `not_configured` | "AI answers are not set up on this server." / (none) | "No AI provider is configured." / "Check the AI provider settings and API key on the server." |
  | undefined or unknown | existing "AI answers are temporarily unavailable." (no body) | same |

  Admin means `useCurrentUser().isAdmin` (find the hook the scene already uses for roles; do not add a new role mechanism). Keep the "Search instead" action on every variant.

- [ ] **Step 1: Write the failing tests**: a `unavailableCopy` table test for every row above for both roles (exact strings); `Notices.test.tsx`: a failed turn with `problem: "unavailable"` and `cause: "billing"` renders the member copy and no "Anthropic"; the admin render contains "Anthropic" and "Plans & Billing"; a turn with no cause renders the generic copy and the search link (Review Focus 2); an unknown provider renders "the AI provider" (Review Focus 3); the model test: an unknown `cause` string is dropped.
- [ ] **Step 2: Run** `.../isodb-errors.sh npx corepack@0.34.0 yarn test app/scenes/AISearch`. Expected: FAIL.
- [ ] **Step 3: Implement** the model field parsing, `unavailableCopy`, and the notice wiring.
- [ ] **Step 4: Run** `app/scenes/AISearch` tests, `yarn tsc`, lint and format check on changed files. Expected: pass.
- [ ] **Step 5: Commit** `feat(ai-search): explain why AI answers are unavailable, by role`.
