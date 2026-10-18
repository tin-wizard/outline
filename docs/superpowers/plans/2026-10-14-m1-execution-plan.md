# AI Search Milestone 1 — Controlled Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox syntax. **Do not start until the owner approves this plan (see Gate G0).**

**Goal:** Make AI answers safe, bounded and measurable: no stored answer text, secrets redacted before the model, excluded collections never retrieved, a $25/workspace/month cap, a concurrency cap, a provider-neutral answer contract with a verifier, and an eval baseline.

**Architecture:** All work stays inside `plugins/ai-answers` plus three additive migrations and one collection toggle. Retrieval keeps `buildWhere` as the single permission gate. The model call becomes provider-neutral behind `contract.ts`; Anthropic is the only provider in M1.

**Tech Stack:** TypeScript, Koa, Sequelize (additive migrations), Redis, Vitest, MSW.

**Spec:** `docs/superpowers/plans/2026-10-14-ai-search-final-architecture-and-milestones.md` (M1 items 1.1–1.10), `docs/superpowers/plans/2026-10-13-ai-answers-v2-measure-verify-budget.md` (tasks reused as 1.8–1.9).

## Global Constraints

- Branch per milestone (D1): `feat/ai-answers-m1`, cut from `main`. No direct pushes to `main`.
- Model `claude-sonnet-5-5` (D5). Monthly cap `$25`/workspace (D5), env `AI_ANSWERS_MONTHLY_BUDGET_USD=25`.
- Document-grounded answers only; general knowledge OFF (D7). Members and admins only; guests/viewers-as-guests denied (D8).
- Stop storing new answer text (D3). Historical rows are **not** deleted or nulled without separate owner approval.
- Conversation state (M2) uses Redis, 60-minute expiry (D4) — not built in M1, only reserved in the contract.
- pgvector / vendor choice deferred to M3 (D6). No `CREATE EXTENSION`.
- No production change, merge, deploy or data change without explicit approval at the gates below.
- Tests run only against the local `.env.test` DB or `outline_ai_m1`. Never `.env` / `.env.local` (they point at production).

## Isolated environment (done)

`scratchpad/m1-env.sh up` creates and migrates local DB `outline_ai_m1` (308/308 migrations) and pins Redis db 8. Script refuses to run unless the DB URL is `127.0.0.1:5432/outline_ai_m1`. Every new migration is first run here, then rolled back (`sequelize db:migrate:undo`) and re-applied, before it is committed.

## Model routing

| Task | Model | Why |
|---|---|---|
| 1.1 measure, 1.2 connection-release spike | opus | touches auth middleware / transaction semantics |
| 1.3 lifecycle, 1.6 stop-storing, 1.7 scan tooling | sonnet | bounded implementation |
| 1.4 redaction, 1.5 exclusion + permission path | opus | security path |
| 1.8 metering/budget/limiter | sonnet, opus review | money + fail-closed behaviour |
| 1.9 contract/verifier/eval | sonnet, opus review | grounding guarantee |
| 1.10 scope map, changelog | haiku | mechanical |
| Final branch review | opus | cross-cutting |

## Tasks

### Task 1.1: Measure before changing (read-only)
- Add timing logs (retrieve ms, model ms, total, pool wait) behind `AI_ANSWERS_DEBUG`; run 20 queries locally against `outline_ai_m1` seeded from fixtures.
- Acceptance: a table of p50/p95 for retrieve vs model; confirms or refutes pool-saturation as cause of ~10 s 502s.

### Task 1.2: Release the DB connection before the model call (spike)
- Files: `server/middlewares/authentication.ts:115-135`, `plugins/ai-answers/server/api/answers.ts`.
- Spike only: can the request-pinned tenant transaction be committed before `generateAnswer`? If it cannot without weakening RLS, stop and report; fallback is the concurrency cap (1.8).
- Acceptance: written finding + test proving no tenant data is read outside the transaction.

### Task 1.3: Request lifecycle
- Abort the Anthropic call on client disconnect; hard timeout 25 s; return documents with `answer: null` on timeout.
- Test (MSW): slow upstream → response within timeout, documents present, no unhandled rejection.

### Task 1.4: Secret redaction (`plugins/ai-answers/server/redact.ts`)
- Pattern classes (draft, owner to confirm): provider keys, VCS tokens, private-key blocks, JWTs, URLs with embedded password, `password|secret|api_key|token = value` assignments.
- Applied to every section sent to the model and to the query. Replace with `[REDACTED:<class>]`.
- TDD: one failing test per class + a false-positive test (prose containing the word "password").
- Acceptance: eval case with a planted secret never reaches the MSW-captured request body.

### Task 1.5: Per-collection exclusion
- Migration `…-add-collections-ai-excluded.js`: `collections."aiExcluded" boolean not null default false` (additive, no backfill).
- `server/models/Collection.ts` attribute; `CollectionForm.tsx` toggle (admins only); presenter + update schema.
- `retrieve.ts`: add `NOT IN excluded collection ids` to the retrieval query in addition to `buildWhere`.
- Tests: excluded collection doc is never returned even for an admin; non-excluded unchanged; guest denied.
- Applied to production only at Gate G3, and only the owner-approved collections below.

### Task 1.6: Stop storing answer text
- `answers.ts`: remove `answer: answer ?? undefined` from `SearchQuery.create`; keep `results`, `duration`, add `answered boolean` only if needed (otherwise skip — ponytail).
- Test: after a successful answer, `search_queries.answer` is NULL for the new row.
- Retention of historical rows: unchanged (see Gate G4).

### Task 1.7: Existing-answer scan tooling
- Reusable count-only script (scratchpad, not committed): per-class counts, never prints content. Already run once: 30 answers / 0 flagged; 366 queries / 0 flagged.

### Task 1.8: Metering, budget, concurrency, limiter
- Migration `20261014000000-create-ai-answer-usages.js` with RLS `tenant_isolation` policy; `usage.ts`, `pricing.ts` (Sonnet 5.5 $2 in / $10 out per MTok).
- Budget check before call (fail closed: if usage lookup errors → no model call, documents only). Per-workspace concurrency cap 3. Rate limit stays 10/min.
- Tests: over-budget → `answer: null` + documents; lookup error → fail closed; cost arithmetic.

### Task 1.9: Contract, verifier, eval baseline
- `contract.ts` (provider-neutral `AnswerRequest/AnswerResult`), `verify.ts` (`verifyAnswer`: every sentence maps to ≥1 citation whose quote is a substring of a sent section), `providers/anthropic.ts`, `eval/{score.ts,cases.json,run.mjs}`.
- Acceptance: baseline score file committed; verifier rejects an invented sentence in a unit test.

### Task 1.10: Scope map + member gate
- Register `documents.answerQuestion` in `shared/helpers/AuthenticationHelper.ts` scopes; deny guests (D8).

## Gates (explicit owner approval required)

| Gate | What | Needed before |
|---|---|---|
| G0 | Approve this plan + redaction pattern list + collection list | any code |
| G1 | PR review/merge of `feat/ai-answers-m1` | anything on `main` |
| G2 | Deploy (Watchtower picks `latest` on merge; migrations auto-run) | production exposure |
| G3 | Set `aiExcluded` on approved collections; set `AI_ANSWERS_MONTHLY_BUDGET_USD=25` in server `.env` | production data/config change |
| G4 | Null or delete historical `search_queries.answer` rows | any data deletion |
| G5 | ZDR in force (contract) | sending customer content under ZDR assumption |

## Rollback

Code: revert merge commit; image tag `outline-rollback:pre-ai-answers` exists on the server. Migrations are additive (nullable/defaulted column, new table) so no down-migration is needed for rollback. Feature kill-switch: workspace toggle `AIAnswers` off, or unset `ANTHROPIC_API_KEY`.

## Acceptance criteria for M1

1. No new `search_queries.answer` value is written. 2. A planted secret never appears in a captured model request. 3. A doc in an excluded collection is never retrieved. 4. Over-budget and limiter-error paths return documents with no answer. 5. Verifier rejects ungrounded sentences; eval baseline recorded. 6. All new migrations apply and undo cleanly on `outline_ai_m1`. 7. `yarn tsc`, `yarn lint`, and the touched test files pass.
