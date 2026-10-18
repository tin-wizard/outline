# Option A Fidelity Pass — Plan

**Goal:** Make the live AI Search match the owner-chosen "Option A · Familiar chat" mockup (`scratchpad/ai-audit/mockups/option-a-familiar-chat.html`) — the merged build (PR #40) has the behaviour but not the look, and lacks several mockup features. Owner instruction (2026-10-18): "build the fidelity pass with everything in the mockup."

**Inputs:** the element-by-element gap list `scratchpad/ai-audit/fidelity-gaps.md` (56 KB: each element, what's built, what needs backend, size, approach, adaptation notes); the mockup + `_src/`; M1/M2/hardening/history reports under `.superpowers/sdd/` in `/Users/developer/Projects/outline-hardening`.

**Branch:** `feat/ai-option-a-fidelity` (worktree `/Users/developer/Projects/outline-fidelity`, from `origin/main` 7e7218288). One PR, stop at the PR; no merge/deploy without owner approval.

## Constraints
- All earlier owner decisions stand: documents-grounded only, members/admins only, redaction, `aiExcluded`, quota/budget guards, history opt-in per workspace (default off), 90-day retention, owner-only chats, hidden turns when sources revoked, no content in logs, production DB role bypasses RLS (explicit team/user scoping everywhere), safe rendering (no HTML/links/images from model output; links only via `isDocPath`).
- Match the mockup using Outline's theme tokens and breakpoints (737/1025), not the mockup's hard-coded colours; both themes; accessible; responsive 375/768/1440. Do NOT write UI copy that the system cannot guarantee (drop "nothing was charged", "none of the N documents mention X", derived differences in Compare).
- Tests: isolated DB `outline_ai_m1` only (credentials from `.env.test`, never printed, `NODE_ENV=test`, `PGSSLMODE=disable`); never `.env`/`.env.local`. CLAUDE.md conventions; TDD; explicit `git add`; commit trailers per model. Migrations additive with `down()` and `lock_timeout`, only if truly needed.

## Slices (from the gap analysis, adapted)
Wave 1 (parallel, disjoint files):
- **BE-1 (opus)** backend data for the UI: `sources` event + info: `collectionId`, `updatedAt`, `updatedBy` name, stale flag basis; per-turn stored scope (collections, documents, date range) and stored `timings` (`totalMs`) and retrieval counts (candidates retrieved / used) in `done` + stored; `ai.ask` new params: `dateFilter`, `collectionIds[]`, `documentIds[]` with the SAME permission checks as the single-value ones (authorizeFilterFields on every id; no existence oracle; exclusion honoured); error details: budget reset time, `scope_forbidden` reason naming nothing; `aiConversations.info` returns scope/timings/createdAt for "Resumed · started …"; feedback reason enum + optional comment ("report inaccurate"), stored on usage row (additive migration if needed); documents picker endpoint reuse (`documents.search_titles`) — verify it suffices.
- **FE-A (sonnet)** shell: header via Scene `left` prop (breadcrumb "AI Search › title", Private badge, icon buttons for download/print/copy menu, drawer toggle), "Resumed · started <date>" divider, sidebar Chats | Library tabs (shared sidebar swap), New chat with ⌘⇧O hint (check collisions), pin icons, Drafts count badge as in mockup, empty-state hero (centred, composer mid-page, 2×2 suggestion cards), mobile shell (hamburger, chats drawer, sticky composer).
Wave 2:
- **FE-B (sonnet)** answer turn: avatar glyph (no "ANSWER" label), Verified pill + source stack above the answer, icon action row with "Answered in N s", citation hover card (heading, highlighted passage, "Cited N× in this answer", "Open at section"), Sources panel (full-height, coverage banner, source cards with number badge/section chips/highlighted excerpt, "Searched N · M matched but weren't used" from BE-1 counts, stale-source badge), streaming progress states, partial/gap notice cards (use existing gap-lead detection), error cards (budget reset, permission, timeout, rate limit) with calm copy.
- **BE-2 (opus)** Compare mode behind a team-level flag default off: prompt mode + verifier rules that release only verbatim values per source (no derived differences, no summary sentence), table with per-row citations, tests with the audit's comparison fixtures (combined sentence, derived number, false comparative must be dropped); expose `mode: "compare"` in `ai.ask`.
Wave 3:
- **FE-C (sonnet)** composer card + scope chips: rounded card, round send button, collection selector (multi), "Specific documents" picker (search_titles), "Any time" date filter, "Compare" chip (when flag on), scope line under each question and persisted scope on resume, disclaimer line, keyboard hints; "Save as document" (draft via documents.create, text built from released blocks only) and "Report inaccurate" dialog (reasons from BE-1).
- **Q (opus)** browser QA against the local mock server (same method as before), side-by-side screenshots against the mockup for every state at 1440/768/375 light+dark; fix differences.
- Final whole-branch review (opus), fix wave, PR.

## Out of scope / adapted (owner informed)
Sub-question coverage ("2 of 3 parts answered") only if the data supports it cheaply — otherwise render the partial state without that line; PDF stays print-to-PDF; no role badge in the shared sidebar footer; the mockup's Compare summary sentence and derived deltas are not produced (verifier would drop them).
