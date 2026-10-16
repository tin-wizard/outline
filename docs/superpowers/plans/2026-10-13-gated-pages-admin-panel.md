# Gated Pages Admin Panel Implementation Plan

**Status:** Final draft for build. Not approved. Checked against the fork and the TIN Cloudflare account on 2026-10-13.

**Goal:** Let administrators create, publish, measure and secure **gated sites** from Settings → Pages in Outline. Each site is one folder and one gate under `pages.<domain>/<slug>/`, with an optional custom domain, view measurement including time on page, and admin-only reset and rotation of the access code.

**Architecture:** A new plugin, `plugins/pages-gate`, modelled on `plugins/webhooks`: a `plugin.json`, `server/index.ts` registering `Hook.API` and `Hook.Task`, and `client/index.tsx` registering `Hook.Settings`. No core Outline files change. R2 is reached through the S3 API with the existing `@aws-sdk/client-s3` and `@aws-sdk/lib-storage`. Measurement copies the structure of document insights (raw events, daily and weekly rollups, cleanup task, per-site switch). Phase 1 serves encrypted pages with one generated code per folder. Phase 2 puts a Cloudflare Worker in front of a private bucket and adds per-person access (PPA) and custom hosts.

**Tech Stack:** TypeScript, Koa, Sequelize and PostgreSQL, Redis queues, React with MobX and styled-components, Vitest, Cloudflare R2, Workers and Workers KV (Phase 2).

**Sources:** KB page "Plan — gated pages admin panel (2026-10-13)" (Programming KB, Products → outline), `docs/ARCHITECTURE.md`, `AGENTS.md`, `plugins/webhooks`, `server/models/DocumentInsight.ts` and the insight tasks, the existing gate (`docs/architecture/archify/gate/encrypt-site.mjs` in `tindevelopers/tin-boss-api`), and the Cloudflare account checks below.

## Verified facts (2026-10-13)

| Fact | Result |
|------|--------|
| Fork version and plugin system | Outline 1.10.1. `PluginManager.add` with `Hook.API`, `Hook.Task`, `Hook.Settings` confirmed in `plugins/webhooks` |
| Existing S3 client | `@aws-sdk/client-s3`, `lib-storage`, `s3-request-presigner` already dependencies. No new dependency |
| Insights in core | `View`, `DocumentInsight` (day and week: views, viewers, comments, reactions, revisions, editors), `RollupDocumentInsightsTask`, `RollupWeeklyDocumentInsightsTask`, `CleanupDocumentInsightsTask`, per-document `insightsEnabled`. **No time on page** |
| Bucket `tin-sow` | Region WEUR, custom domain `pages.tin.info` enabled, r2.dev access off. Serves the existing pages (`platform-architecture/`, `platform-onboarding/`) and now `implexus-platform/` |
| Buckets `tin-dealroom`, `tin-dealroom-public` | Created 2026-10-12. `tin-dealroom-public` has custom domain `files.dealroom.tin.info`. A different product; do not reuse |
| Account | Shared with other zones and buckets, so token scope matters |
| Token capabilities (the credential now in the working environment) | Works: R2 buckets, upload to `tin-sow`, read zones (including `tin.info`), read Worker scripts (none exist). **Does not work (Authentication error):** custom hostnames (SSL for SaaS), DNS records, Workers KV, Queues |
| First gated site | `implexus-platform` was published by hand on 2026-10-13 using the existing gate: HTTP 200, page is ciphertext only, noindex. Proves the Phase 1 pipeline end to end. Unlock with the code still to be tested by the owner |

**Consequence 1: private bucket versus Phase 1 serving.** An R2 custom domain exposes the whole bucket publicly. A private bucket therefore cannot serve Phase 1 pages directly. Resolution (decision D1): Phase 1 uses a **new bucket, `tin-pages-gated` (proposed name), with its own public custom domain** (ciphertext only is public). Phase 2 removes that public binding and serves from the same bucket through the Worker, so the bucket becomes private.

**Consequence 2: token scope.** Three credentials, never one:

| Credential | Held by | Permissions |
|------------|---------|-------------|
| R2 S3 key pair (access key id and secret) for `tin-pages-gated` only | The Outline server at runtime | Object read and write on that bucket |
| Deploy token | CI or an administrator, never the Outline server | Workers Scripts Edit, Workers KV Storage Edit, Queues if used, Zone DNS Edit if the panel manages records |
| Hostname token (Phase 2) | The Outline server | SSL and Certificates Edit on the one zone used for custom hostnames. Needs Cloudflare for SaaS enabled on the account (not yet confirmed) |

The general-purpose token used for the 2026-10-13 manual publish must not be given to the Outline server.

## Decisions

| # | Decision | Status |
|---|----------|--------|
| D1 | New bucket `tin-pages-gated`; public custom domain in Phase 1, private behind the Worker in Phase 2 | Proposed, confirm name and domain |
| D2 | One generated code per folder in Phase 1; per-person access in Phase 2 | Owner, 2026-10-13 |
| D3 | Administrators only: workspace admins and platform admins | Owner, 2026-10-13 |
| D4 | Each site may have a custom domain (served in Phase 2) | Owner, 2026-10-13 |
| D5 | Measurement follows the document insight pattern and adds time on page | Owner, 2026-10-13 |
| D6 | Only administrators reset or rotate codes; users cannot | Owner, 2026-10-13 |
| D7 | Canonical repository (`tin-wizard/outline` or `tindevelopers/outline`) | Open |
| D8 | Store the code encrypted in the database, or require re-entry on each publish | Open |
| D9 | Second administrator approval for Restricted sites | Open |

## Global Constraints

- Follow `AGENTS.md`: TypeScript strict, no `any`, curly braces on every `if`, named exports for new files, JSDoc on exported functions, oxfmt formatting. Do not add translation strings by hand.
- No core Outline file changes. Everything lives in `plugins/pages-gate`.
- Access codes are never logged, never stored in a KB page, never in an event payload. Only the fact and time of a rotation are recorded.
- Codes are always generated by the server (16 characters from a 31-character alphabet, about 79 bits). Administrators cannot choose one.
- Every R2 key is built from a validated slug and must start with `sites/<slug>/`. Reserved slugs are refused: `platform-architecture`, `platform-onboarding`, `implexus-platform` (until migrated), `robots.txt`, `_headers`.
- Admin routes use the existing policies and rate limiters. Members, guests and visitors are refused on every route except the measurement ingest.
- Environment variable names (proposed, values never committed): `PAGES_R2_ACCOUNT_ID`, `PAGES_R2_ACCESS_KEY_ID`, `PAGES_R2_SECRET_ACCESS_KEY`, `PAGES_R2_BUCKET`, `PAGES_PUBLIC_BASE_URL`, `PAGES_CODE_ENCRYPTION_KEY`. Read through `server/env.ts`.
- Tests never touch a production database or the real bucket. Use `.env.test` and a local S3-compatible store. Call `node_modules/.bin/vitest` directly if global yarn is v1.
- Add the plan's measurement beacon to published pages only when the site's measurement switch is on.

## Reset and rotation rules

- Only administrators can create, show once, rotate or reset a code. Enforced by server policy, not only in the UI. There is no "forgot code" flow on the gate page.
- **Rotate:** new code and salt, re-encrypt every page, upload, purge cache, show the new code once, record who and when.
- **Reset:** rotate, plus (Phase 2) revoke every person token for the site.
- Rotation and reset require the administrator to re-authenticate. Restricted sites also need a second administrator (D9).
- Phase 1 limit, stated in the UI: the ciphertext is public, so anyone who saved an older copy and the old code can still read that older content. Rotation protects future content only.

## Measurement rules

- Beacon sends `view`, a `heartbeat` every 15 seconds while the page is visible, and `end` with `navigator.sendBeacon` on `pagehide`. Active time counts visible time with interaction in the last 30 seconds (assumption to confirm).
- Phase 1 ingest is a rate-limited Outline API route with a per-site write token and strict CORS. Phase 2 moves it to the Worker (`/_m`).
- Raw events go to `pages_view_events` and roll up into `pages_insights` (day, week). A cleanup task deletes raw events after the retention period (suggested 90 days, to confirm).
- No cookies, no IP storage, coarse country only. Phase 1 visitors are anonymous (one shared code). Person-level data exists only in Phase 2 and is administrator-only, with a notice on the gate page.

## Custom domain rules

- Administrator enters a hostname; the panel shows the DNS record; activation needs DNS proof of ownership.
- Refuse reserved and TIN hostnames, no wildcards, deprovision on site delete.
- Serving a custom host needs the Worker and a host-to-site map in Workers KV, so it ships in Phase 2. The `pages_domains` table and the panel field ship in Phase 1.

## Tasks

**Phase 0: decisions and setup**

- [ ] Confirm D1, D7, D8, D9 and the retention and idle-cutoff values.
- [ ] Create `tin-pages-gated`, its public custom domain and the R2 S3 key pair (needs the owner; token scopes above).
- [ ] Commit the spec for this plan under `docs/superpowers/specs/`.

**Phase 1: panel, publishing, rotation, measurement**

- [ ] Task 1: plugin skeleton (`plugin.json`, `server/index.ts`, `client/index.tsx`, empty Settings screen, feature flag).
- [ ] Task 2: models and migrations for `pages_sites`, `pages_publications`, `pages_domains`, `pages_view_events`, `pages_insights`.
- [ ] Task 3: policies and API routes (create, list, update, publish, delete) with refusal tests for non-administrators.
- [ ] Task 4: slug validation and the R2 key guard, with traversal and reserved-name tests.
- [ ] Task 5: gate encryption library, ported from `encrypt-site.mjs` (AES-GCM, PBKDF2 600,000 iterations), with round-trip tests.
- [ ] Task 6: R2 client and publish and unpublish tasks (render to static HTML, Mermaid at publish time, attachments, upload with `lib-storage`, `no-cache`, noindex).
- [ ] Task 7: rotate and reset routes, re-authentication step, one-time code display, audit events.
- [ ] Task 8: Settings → Pages screens (list, create, publish, rotate, reset, delete).
- [ ] Task 9: measurement beacon, ingest route, rollup and cleanup tasks, tests for heartbeat accounting, idle cutoff, duplicates and retention.
- [ ] Task 10: Insights tab (views, visitors, average and median time on page, top pages).
- [ ] Task 11: first real site: migrate `implexus-platform` into the panel; confirm the old object is replaced only after the new one is verified.

**Phase 2: per-person access, Worker, custom hosts**

- [ ] Task 12: Worker on `pages.<domain>` and custom hosts (token check, revocation list in KV, serves from the private bucket, `/_m` ingest).
- [ ] Task 13: `pages_access` table, Access tab, administrator-only invite, extend, revoke.
- [ ] Task 14: custom hostnames (verification, certificate status, host-to-site map).
- [ ] Task 15: Activity tab (who viewed and for how long), privacy notice, retention enforcement.
- [ ] Task 16: tokens issued by the KaaS key service when it exists; until then signed with a key held in Worker secrets.

**Hardening**

- [ ] Security review (prefix guard, policies, ingest abuse), privacy review for person-level tracking, runbook for rotating the R2 key pair and the deploy token.

## Tests

- Policy tests: members and guests refused on every admin route including rotate and reset.
- Unit tests: slug, key builder, prefix guard, encryption round trip, code generator alphabet and length.
- Measurement tests: heartbeat accounting, idle cutoff, duplicate and out-of-order events, rollup totals, retention cleanup.
- Integration: publish, rotate, delete against a local S3-compatible store.
- End to end: a published page does not open without the code; after rotation the old code fails on the new files; a revoked token fails (Phase 2); a custom host serves only its own site.

## Effort (rough, refine after Phase 0)

| Step | Estimate |
|------|----------|
| Phase 0 | 1 to 2 days, plus owner time for Cloudflare |
| Phase 1 including rotate and reset | 9 to 14 days |
| Measurement | 5 to 7 days |
| Phase 2 Worker, PPA, Access and Activity | 8 to 10 days |
| Custom domains | 5 to 8 days after Cloudflare for SaaS is confirmed |
| Hardening | 4 to 6 days |

## Risks

| Risk | Handling |
|------|----------|
| Phase 1 ciphertext is public | One code per folder; rotation protects future content only; no Restricted material until Phase 2 |
| R2 keys are bucket-wide | Prefix guard in code, dedicated bucket, key pair scoped to that bucket |
| Over-broad Cloudflare token on a shared account | Three scoped credentials; runtime server never holds the deploy token |
| Cloudflare for SaaS not enabled | Confirm before promising custom hosts |
| Person-level viewing data | Notice, administrator-only access, retention limit, per-site switch, legal review |
| Ingest endpoint abuse | Per-site token, rate limits, bot filtering, Worker proxy in Phase 2 |
| Upstream merges | Everything in one plugin |

## Open questions

1. Canonical repository for this work (D7)?
2. Own measurement or Umami?
3. Who owns the Cloudflare account and issues the three credentials?
4. Is Cloudflare for SaaS enabled, and at what cost?
5. Client-owned DNS or subdomains of ours only?
6. Platform administrators: a role or a group in Outline?
