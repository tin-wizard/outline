# AI Search Milestone 2 — Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** A complete AI Search experience: a streamed, conversational, cited `/ai` page backed by `ai.ask` (SSE), with follow-ups, safe structured Markdown, retrieval hygiene, an **Ask AI** entry from Search and from documents, and feedback buttons.

**Architecture:** New streaming route `ai.ask` in `plugins/ai-answers`, reusing M1's contract, redaction, exclusion, metering, deadline/abort and early transaction release. Conversation state lives in Redis (60 min). The old `documents.answerQuestion` endpoint stays until the new page is verified. The frontend is a new SPA route using a fetch-stream helper and the read-only editor for safe Markdown.

**Tech Stack:** Koa SSE over POST (precedent `server/routes/mcp/index.ts`), Redis, Anthropic Messages streaming + citations, React/MobX/styled-components.

**Spec:** `docs/superpowers/plans/2026-10-14-ai-search-final-architecture-and-milestones.md` (sections A, C, D "Milestone 2"). Builds on M1 (PR tin-wizard/outline#37, unmerged).

## Global Constraints

- Branch `feat/ai-answers-m2`, stacked on `feat/ai-answers-m1` (PR base = M1 branch until M1 merges, then retarget to `main`). Stop at the PR; no merge/deploy without approval.
- Decisions: Sonnet 5.5 (D5), $25/workspace/month (M1 meter), Redis conversation 60-min expiry (D4), document-grounded only / no general knowledge (D7), members and admins only (D8), no new vendor/pgvector (D6), no stored answer text in `search_queries` (D3).
- Every model call keeps M1's guards: budget OK + unmetered key absent + slot; abort on disconnect; deadline; request transaction released before the model call; redaction; `aiExcluded`.
- No model-written links/HTML/images ever reach the client; citations are server-generated from verified source ids.
- Tests only against the local `.env.test` DB or isolated `outline_ai_m1`; never `.env`/`.env.local`.
- CLAUDE.md conventions. Translations are extracted automatically (use `t()`, don't edit JSON).

## Rulings (controller, 2026-10-16)

- Reuse `TeamPreference.AIAnswers` as the single feature flag for Search/AI page/Ask-AI entries (the spec's separate `AISearch` flag adds a setting for no benefit). Cost if wrong: renaming later is mechanical.
- Build backend first (2.4 → 2.3 → 2.2 → 2.1), review it as a unit, then frontend (2.5 → 2.9).
- Latency acceptance (first verified text ≤ 3.5 s p75 through the real proxy) and Caddy SSE buffering cannot be proven locally: they are owner steps after deploy; the plan only supplies a probe script.

## Model routing

| Task | Implementer | Reviewer | Why |
|---|---|---|---|
| 2.4 retrieval hygiene | sonnet | sonnet | plugin-local |
| 2.3 block verifier + prompt | opus | opus | grounding path |
| 2.2 conversation + standalone query | opus | opus | permission re-authorization |
| 2.1 SSE route | opus | opus | streaming + metering + abort |
| 2.5 stream helper | sonnet | sonnet | small |
| 2.6 AI page + safe Markdown | sonnet | opus | XSS surface |
| 2.7 Search Ask-AI, 2.8 doc action | sonnet | sonnet | small UI |
| 2.9 feedback | sonnet | sonnet | small |
| Final | — | opus | whole branch |

## Tasks

### 2.4 Retrieval hygiene (`text.ts`, `retrieve.ts`)
Split slug/path tokens (`mvanhorn/cli-printing-press` → `mvanhorn`, `cli`, `printing`, `press` plus the compound); keep 2-letter terms when upper-case or quoted; no popularity boost; AND first then OR fallback; trigram title fallback via installed `pg_trgm`. Acceptance: unit tests on the token cases above; a retrieval test where the path-style query finds a document it previously could not; no change to permission filtering.

### 2.3 Block verifier + adaptive prompt (`verify.ts`, `contract.ts`)
Allowed output: paragraphs, headings, bold/italic, lists, tables, inline code, code blocks. Disallowed: HTML, images, embeds, model-written links, novel URLs/emails. Per-block rules from spec section "Safe structured answers" (claim blocks need a citation or ≥25-char verbatim copy; short headings ≤80 chars with no URL/email/digits-as-claims/identifiers absent from sources; code blocks must be verbatim substrings of a sent section). Adaptive prompt by question type; raise `max_tokens` consistently with the M1 estimate; no sentence-count limit. Keep M1's per-sentence support check for claim blocks. Acceptance: tests per block class, a table case, an injected-link case, a heading-smuggling case.

### 2.2 Conversation store + standalone query (`conversation.ts`, `retrieve.ts`)
Redis key `aiconv:{teamId}:{userId}:{id}`, 60-min sliding TTL, max 8 turns, ~6k-token history budget; server-written only (client holds just the id); verify ownership each turn; standalone query = previous question(s) + titles of previously cited documents the user can still read; prior answer text included only if every cited document is still readable now. Acceptance: scripted conversation test where "How does it connect to Lifescape?" resolves "it"; revoked permission between turns removes that document's prior answer text; a foreign `conversationId` is rejected; TTL/turn cap enforced.

### 2.1 Streaming endpoint `ai.ask`
SSE over POST (`ctx.respond = false`), events `status`, `sources`, `block`, `done`, `failed`; heartbeat; per-route compression off (`server/services/web.ts` ~72) and timeouts via the M1 per-route timeout; M1 guards (budget, slot, unmetered, abort, deadline, early transaction release, metering of streamed usage, outcome labelling); stop cancels the upstream call; released blocks only after `verifyBlock`, final gate `verifyFinal`; no answer text persisted outside the Redis conversation. Old endpoint untouched. Acceptance: tests for event order, abort mid-stream (usage records truncated tokens), failed-with-partial state, over-budget → `failed`/no model call, guests/viewers 403, plus a probe script for proxy buffering.

### 2.5 Frontend stream helper (`app/utils/streamFetch.ts`)
fetch + reader + CSRF header + AbortController; typed event parsing; tests.

### 2.6 AI Search page (`app/scenes/AISearch/*`)
Route `/ai`, sidebar item (flag-gated), `useAIAnswersEnabled()`, scope chips (collection/document), message list, composer, Stop, New conversation, states (idle, searching, writing, no results, couldn't fully verify, stopped), sources panel, numbered citations linking to section anchors (`headingToSlug`), safe Markdown through the read-only `Editor` with a curated extension list (no Image/Embed/Attachment/Video, no links except server citations), `aria-live="polite"` + `aria-busy`, mobile layout at 375 px.

### 2.7 Search page
Remove the auto answer card and its request; add flag-gated **Ask AI** button carrying `q`, `collectionId`, `documentId` to `/ai`.

### 2.8 Document action
Flag-gated **Ask AI about this document** (clone of `searchInDocument` in `app/actions/definitions/documents.tsx`), listed in the document menu.

### 2.9 Feedback
Helpful / not helpful on the AI page, stored as metadata only (no answer text), per the existing patterns.

## Gates

| Gate | What |
|---|---|
| G-M2a | Backend (2.4–2.1) reviewed together before frontend starts |
| G-M2b | Final whole-branch review, PR against the M1 branch |
| G-M2c (owner) | Deploy order: M1 → M2; enable flag; run latency + Caddy probes; set up eval baseline |

## Acceptance (from spec) / what can be proven here

Provable in tests: follow-up resolution, permission re-authorization, stop cancels model call, no AI request from Search page, `aria-live` present, mobile layout (375 px visual check), old endpoint still works. Owner-only after deploy: first verified text ≤ 3.5 s p75 through the proxy, SSE not buffered by Caddy.

## Rollback

Flag off hides the page and entries; old endpoint remains; no new migrations planned in M2 (Redis only).
