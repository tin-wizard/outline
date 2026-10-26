# AI Search Option A Redesign — Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Turn AI Search into a ChatGPT-style product (Option A "Familiar chat"): durable per-user conversation history with a Chats list in the sidebar, sources drawer with real citations and previews, copy/export, follow-up suggestions — on top of the existing `ai.ask` pipeline.

**Decisions (owner, 2026-10-18):** Option A; deliver in ONE combined PR with the hardening work (branch `feat/ai-hardening`, PR #40); store conversation answers for **90 days**; **per-workspace on/off switch** for history; conversations are **deleted with the user**. Standing defaults I am applying (not contradicted): admins cannot read anyone's conversation content (aggregate counts only); when a cited document is no longer readable or becomes AI-excluded, the affected block is hidden when a chat is reopened; answers redacted on write; guests/viewers get nothing (D8); document-grounded only (D7); Sonnet 5.5 and budget/quota guards unchanged.

**Architecture:** Two additive RLS'd tables (`ai_conversations`, `ai_conversation_turns`) storing per-block verified Markdown + citations; `aiConversations.*` RPC routes following repo conventions; `ai.ask` persists turns when history is enabled (Redis stays the hot context cache); retention cron (90 days) cloned from `CleanupOldSearchQueriesTask`; frontend MobX `AIConversationsStore` + sidebar Chats section built from existing sidebar components; `/ai/:id` route; right-hand Sources drawer reusing the right-sidebar pattern; rest of the `AISearch` scene extended, not rewritten.

**Spec/inputs:** audit report (`scratchpad/ai-audit/AI-Search-Audit-Report.md`), mockup `scratchpad/ai-audit/mockups/option-a-familiar-chat.html`, M1/M2 reports in `.superpowers/sdd/`.

## Global Constraints
- Branch `feat/ai-hardening` in worktree `/Users/developer/Projects/outline-hardening`; never edit `/Users/developer/Projects/Outline` (shared); stop at the PR (#40 updated); no merge/deploy without owner approval.
- Tests only on isolated DB `outline_ai_m1` (credentials from `.env.test`, never printed, `NODE_ENV=test`, `PGSSLMODE=disable`); never `.env`/`.env.local`.
- Additive migrations with `down()`, `lock_timeout` 5s, RLS `tenant_isolation` with the **nullif** policy variant (see `20261016130000`); all tenant queries scoped by teamId+userId explicitly (production DB role bypasses RLS).
- No answer text outside these tables/Redis; redact on write; no content in logs.
- CLAUDE.md conventions; TDD; explicit `git add`; commit trailer per model.
- New env/preference: `TeamPreference.AIConversationHistory` (default **false** — changed 2026-10-18 at final review so enabling AI answers never starts storing chats silently; admins opt in via the toggle in Settings → Features next to AI answers); retention constant 90 days (env `AI_HISTORY_RETENTION_DAYS`, default 90, clamp 1–365, never fails validation).

## Model routing
| Task | Implementer | Reviewer |
|---|---|---|
| H1 history storage + API | opus | opus |
| H2 ask.ts persistence + revocation rendering | opus | opus |
| C1 citations UI (quote, hover, open section) | sonnet | sonnet |
| C2 anchor correctness (server) | sonnet | sonnet |
| E1 copy / export Markdown | sonnet | sonnet |
| F1 store + sidebar Chats + routes | sonnet | opus |
| F2 Option A layout (sources drawer, verified badge, empty/not-covered, suggestions) | sonnet | opus |
| Q1 browser QA with seeded data | opus | — |
| Final whole-branch review | — | opus |

## Tasks

### H1 — History storage and API (backend, no ask.ts changes)
Migration `ai_conversations` (id uuid, teamId, userId FK ON DELETE CASCADE, title, pinnedAt, createdAt, updatedAt, deletedAt) and `ai_conversation_turns` (id, conversationId FK CASCADE, teamId, userId, position, question, blocks jsonb [{kind, markdown, citations:[{documentId, quote, sectionIndex, heading}]}], citedDocumentIds uuid[], outcome, usageId, createdAt); indexes `(teamId,userId,updatedAt DESC)`, `(conversationId, position)`; RLS ENABLE+FORCE+nullif policy on both. Models, presenter, policy (owner only), zod schemas, routes `aiConversations.list` (offset/limit/query/pinned; search by title + question text, FTS or ILIKE), `.info` (turns, re-authorised on read: each block whose citations include a now-unreadable or AI-excluded document is returned as `hidden: true` without text — reuse the exported `readableDocuments`), `.update` (title, pinned), `.delete`; gates identical to `ai.ask` (`assertAIAnswersAllowed`, history preference); rate limits; scope map; retention task (`CleanupOldAIConversationsTask`, deletes older than retention days, registered like the search queries cleanup); workspace preference + Settings toggle. Acceptance: IDOR (other user/team 404), role gates, preference off => 403/empty, revocation hides blocks, retention test, cascade on user delete, migration up/down/up on `outline_ai_m1`.

### H2 — `ai.ask` persistence
When history is enabled: create the conversation on the first turn (title = first question trimmed to 80 chars, redacted), append a turn only from `verifier.released` on `done` (same rule as the Redis store; failed turns store the question with no blocks), never before redaction; include `conversationId` in `done`; `GET`-style resume uses `aiConversations.info`; deleting a conversation also deletes its Redis key (`deleteConversation`); "New chat" calls delete only when the user deletes. Seed the Redis hot cache when resuming an old conversation (rebuild from stored turns, re-authorised). Acceptance: tests for storage on done/failed/abort, redaction on write, preference off => nothing stored, resume continues context with re-authorisation, no content in logs.

### C1 — Citations UI
Render `citation.quote` as an excerpt; hover/popover preview on `[n]` markers (reuse `HoverPreviewDocument`/`Popover`); clicking a marker opens the Sources drawer entry and the link opens the document at the section; show all cited sections per source. Tests with the safe-render rules (no autolinks/HTML).

### C2 — Anchors
Build section anchors with the editor's anchor algorithm incl. occurrence index and heading text stripped of links; split sections fall back to the nearest preceding heading. Tests with the audit's failing fixtures (repeated heading, heading containing a link, split section).

### E1 — Copy / export
"Copy answer", "Copy conversation as Markdown", "Download .md" (turn blocks + numbered source list) and print stylesheet for PDF. Reuse `CopyToClipboard`, toasts.

### F1 — Frontend store + sidebar + routes
`AIConversation` model + `AIConversationsStore` (RPC list/info/update/delete, search), sidebar "Chats" section with Chats | Library switch, groups Pinned/Today/Yesterday/Previous 7/30 days, hover menu (rename inline, pin, export, delete with confirm), search box, `/ai` (new) and `/ai/:id` (resume) routes, New chat button, hydrate reducer from `info`, show hidden blocks as "Source no longer available".

### F2 — Option A layout
Two-pane layout from the mockup: central chat, right Sources drawer (bottom sheet on mobile), verified badge/coverage line, calm "not covered by your documents" notice, follow-up suggestion chips derived from cited headings, composer + scope chips unchanged, responsive 375/768/1440, light/dark, a11y.

### Q1 — Browser QA
Seed local isolated DB with synthetic conversations; run the app against the isolated DB only (no API key needed for history UI); screenshots desktop/mobile light/dark; fix layout bugs.

## Gates
G1 after H1+H2 (backend review as a unit); G2 after F1+F2+C1+C2+E1; G3 final whole-branch review; G4 owner approval before merge. Eval baseline needs an API key and stays an owner step.
