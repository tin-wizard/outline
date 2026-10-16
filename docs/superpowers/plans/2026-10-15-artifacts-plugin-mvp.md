# Artifacts Plugin (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user with edit rights attach an HTML file or a zipped static site to a document and have it run, interactive and animated, inside that document for anyone who can read it, without weakening Outline's CSP.

**Architecture:** A new additive `plugins/artifacts` plugin stores immutable versions in a private R2 bucket under `artifacts/<teamId>/<artifactId>/<versionId>/`. A document embeds `/api/artifacts.open?id=…`, which checks `read` on the document and 302s to a separate sandbox domain with a 15-minute HMAC token in the path. A plugin route on that host streams the bytes from R2 with `CSP: sandbox allow-scripts` (no `allow-same-origin`), so the artifact runs in an opaque origin even inside Outline's permissive `Frame`. No core editor, CSP or `Frame.tsx` changes.

**Tech Stack:** Koa + koa-router plugin (`Hook.API`), Sequelize, `@aws-sdk/client-s3` (R2, reused from pages-gate), `yauzl` (already a dependency), Node `crypto`, Caddy, Vitest.

**Spec:** Design inputs, not in the repo tree: `artifact-audit-report.md` (session scratchpad, Opus audit of 2026-10-15) and `docs/superpowers/specs/2026-10-15-pages-publishing-design.md` on branch `claude/jolly-galileo-37jyv3` (tin-wizard/outline#35). This plan is Phase 0 + Phase 1 of the audit's roadmap. Everything else is a separate follow-up plan (see "Out of scope").

## Global Constraints

- Plugin-only footprint. Allowed core edits: `server/models/index.ts` (append exports), one migration in `server/migrations/`, `deploy/caddy/Caddyfile` (new vhost). Never touch `server/middlewares/csp.ts`, `shared/editor/components/Frame.tsx`, `shared/editor/nodes/index.ts`, `server/editor/index.ts`.
- Artifact bytes are never served from `docs.tin.info`, `*.docs.tin.info`, any `tin.info` host, or the Pages origin. Only from `ARTIFACTS_SANDBOX_HOST`, a separate registrable domain.
- The R2 bucket stays private. No r2.dev URL, no public custom domain.
- Every R2 key lies under `artifacts/<teamId>/<artifactId>/<versionId>/`, enforced in code, not by convention.
- Tenant isolation: every lookup filters by `teamId`; a token is bound to `{versionId, teamId}` and rechecked against the row.
- TypeScript strict, no `any`, no `as`/`!` where avoidable, curly braces on every `if`, named exports at the top of the file, JSDoc on every exported function (project CLAUDE.md).
- Run tests with `yarn test <path>` only on the files named in each task. Never the full suite.
- Local `.env` points at the production DB. Tests must use `.env.test`'s local DB (memory: project_local_env_prod_db).
- No new dependency. `yauzl` and `@aws-sdk/client-s3` are already installed.
- Do not add translation strings manually.

## Review Focus

Failure modes the spec implies but a happy-path test would miss, most likely first. Each has a pinning test in the task that owns the code.

1. Zip entry named `../x`, `/etc/passwd`, `a\..\b` or with a NUL byte must be rejected (Task 3).
2. Zip bomb: small archive, huge uncompressed size, or 10,000 entries (Task 3).
3. Token from team A presented for a version of team B, an expired token, and a token with a flipped signature byte all return 404, not 403, so ids do not leak (Tasks 2, 6).
4. User with `read` on the workspace but not on the document gets 403 from `artifacts.open` (Task 5).
5. Soft-deleted artifact: opener 404 for everyone, serve route 404 even with a still-valid token (Tasks 5, 6).
6. The serve route called with the main app's `Host` header must 404 and never stream bytes (Task 6).
7. Every serve response carries the sandbox CSP, `nosniff`, `no-referrer`, and never `Set-Cookie` (Task 6).
8. `artifacts.create` for a document in another team, or an attachment belonging to another document (Task 5).

## File Structure

```
plugins/artifacts/
  plugin.json                      # id, name, priority
  server/
    index.ts                       # registers Hook.API when ARTIFACTS_ENABLED
    env.ts                         # ARTIFACTS_* settings and ARTIFACTS_ENABLED gate
    lib/
      keys.ts                      # versionPrefix, objectKey, assertSafePath
      keys.test.ts
      token.ts                     # signToken / verifyToken (HMAC, 15 min)
      token.test.ts
      bundle.ts                    # readBundle: html or zip -> validated files
      bundle.test.ts
      headers.ts                   # artifactHeaders(frameAncestors)
      headers.test.ts
      store.ts                     # artifact store: put/get/list/delete under a version prefix
    api/
      artifacts.ts                 # artifacts.create/info/list/delete/open + serve
      schema.ts                    # zod request schemas
      artifacts.test.ts
server/models/Artifact.ts          # new
server/models/ArtifactVersion.ts   # new
server/models/index.ts             # +2 export lines
server/migrations/20261015120000-create-artifacts-tables.js
deploy/caddy/Caddyfile             # +1 vhost block
```

Reuse, do not copy: `createR2Client`, `createR2Store` and the `ObjectStore` interface from `plugins/pages-gate/server/lib/objectStore.ts` (imported by relative path; they take explicit config and never read `process.env`).

## Assumptions to verify (Karpathy rule 1)

These are not confirmed in source. Each is verified by a named step, and the plan stops there if the answer is no.

| # | Assumption | Verified in |
|---|---|---|
| A1 | koa-router path params (`artifacts.serve/:token/(.*)`) work inside a plugin `Hook.API` router mounted under `/api` | Task 1 |
| A2 | CSP `sandbox allow-scripts` on the artifact response yields an opaque origin even inside `Frame` (`allow-same-origin` attribute), in Chrome, Safari, Firefox | Task 0 |
| A3 | Relative asset URLs work when the token is a path segment (`/a/<token>/app.js`) | Task 0 |
| A4 | A same-site cookie is not sent to the sandbox domain, and `localStorage` throws inside the sandbox | Task 0 |
| A5 | `FileStorage.getFileBuffer(attachment.key)` returns an uploaded attachment's bytes (`server/storage/files/BaseStorage.ts:178`) | Task 5 |
| A6 | `GET` + session cookie authenticates through `auth({ type: AuthenticationType.APP })` for a route used as an iframe `src` | Task 5 |
| A7 | Pasting an internal URL as an embed skips the `urls.checkEmbed` frame-ancestors probe (`PasteMenu.tsx:72-80`) | Task 7 |

## Model routing

| Task | `model` | `subagent_type` | Justification |
|------|---------|-----------------|---------------|
| 0. Browser spike | orchestrator | n/a | Needs the user's domain and a real browser; routing rule 5 |
| 1. Plugin skeleton, env, route-param proof | `sonnet` | `general-purpose` | Multi-file, follows pages-gate pattern |
| 2. Keys + token | `opus` | `general-purpose` | Auth/tenant isolation primitive; routing rule 3 |
| 3. Bundle validation | `opus` | `general-purpose` | Untrusted archive parsing; security-sensitive |
| 4. Migration + models | `sonnet` | `general-purpose` | Multi-file, existing pattern (PagesSite) |
| 5. API: create/info/list/delete/open | `opus` | `general-purpose` | Authorization and tenant isolation |
| 6. Serve route + headers | `opus` | `general-purpose` | CSP and sandbox; routing rule 3 |
| 7. Caddy vhost + env docs | `haiku` | `general-purpose` | Mechanical, exact block given; `opus` reviews |
| 8. Production verification | orchestrator | n/a | Production + credentials; routing rule 5 |
| Per-task spec/code review | `sonnet` (`opus` for 2, 3, 5, 6) | `general-purpose` | Per matrix |
| Final whole-branch review | `opus` | `general-purpose` | Security-sensitive feature, per matrix |

Previous-phase review applies before every task after the first: read `git show --stat HEAD` and the hunks, and correct the next brief if names or contracts drifted.

---

### Task 0: Browser spike (gate for everything else)

Answers A2, A3, A4 before any code exists. If A2 fails in any target browser, stop and re-plan; the whole design rests on it.

**Files:**
- Create (outside repo, scratchpad): `spike/index.html`, `spike/app.js`, `spike/style.css`
- No repo changes.

**Interfaces:**
- Consumes: a throwaway host on the intended sandbox domain with TLS (any static host that can set response headers, e.g. a Cloudflare Worker or Caddy file_server).
- Produces: a pass/fail table for A2, A3, A4 plus Safari/iOS notes, recorded in the PR description of Task 1.

- [ ] **Step 1: Write the spike page**

`spike/index.html`:

```html
<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="style.css">
<h1 id="out">running</h1>
<canvas id="c" width="200" height="100"></canvas>
<script src="app.js"></script>
```

`spike/app.js`:

```js
const r = {};
try { localStorage.setItem("k", "v"); r.localStorage = "allowed"; } catch (e) { r.localStorage = "throws"; }
r.cookie = document.cookie === "" ? "none" : "present";
try { r.parentOrigin = String(window.parent.location.origin); } catch (e) { r.parentOrigin = "blocked"; }
r.origin = String(location.origin);
r.webgl = !!document.createElement("canvas").getContext("webgl");
fetch("https://example.com").then(() => r.connect = "ALLOWED (bad)").catch(() => r.connect = "blocked").finally(() => {
  document.getElementById("out").textContent = JSON.stringify(r);
  parent.postMessage({ type: "spike", r }, "*");
});
document.getElementById("c").getContext("2d").fillRect(0, 0, 50, 50);
```

`spike/style.css`: `body{background:#eef}` (proves relative asset loading, A3).

- [ ] **Step 2: Serve it with the target headers on a path with a token-like segment**

URL shape `https://<sandbox-host>/a/TESTTOKEN/index.html`. Response headers for every file:

```
Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; frame-ancestors https://docs.tin.info https://*.docs.tin.info; base-uri 'none'; form-action 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

- [ ] **Step 3: Embed it in a real document and read the result**

In a scratch Outline document paste the URL, choose Embed, and read the rendered JSON. Repeat in Chrome, Safari, Firefox and iOS Safari.

Expected: `localStorage: "throws"`, `cookie: "none"`, `parentOrigin: "blocked"`, `origin: "null"`, `connect: "blocked"`, page background light blue (A3), canvas drawn, no CSP console error for `script-src 'self'` (if there is one, 'self' does not match in the opaque origin; record it and switch the spike to `script-src 'unsafe-inline'` plus `<script>` inlined).

- [ ] **Step 4: Record the table and stop on any failure**

If `origin` is not `"null"` or `parentOrigin` is readable in any browser: STOP. Do not start Task 1.

---

### Task 1: Plugin skeleton, env gate, and the route-param proof

**Files:**
- Create: `plugins/artifacts/plugin.json`
- Create: `plugins/artifacts/server/env.ts`
- Create: `plugins/artifacts/server/index.ts`
- Create: `plugins/artifacts/server/api/artifacts.ts` (skeleton with `serve` only)
- Test: `plugins/artifacts/server/api/artifacts.test.ts`

**Interfaces:**
- Consumes: `Hook`, `PluginManager` from `@server/utils/PluginManager`; `Environment` from `@server/env`.
- Produces: default export `env` with `ARTIFACTS_ENABLED: boolean`, `ARTIFACTS_R2_ACCOUNT_ID`, `ARTIFACTS_R2_ACCESS_KEY_ID`, `ARTIFACTS_R2_SECRET_ACCESS_KEY`, `ARTIFACTS_R2_BUCKET`, `ARTIFACTS_SANDBOX_HOST`, `ARTIFACTS_TOKEN_SECRET` (all `string | undefined`); default export `router` (koa-router) from `api/artifacts.ts`.

- [ ] **Step 1: Write the failing test**

`plugins/artifacts/server/api/artifacts.test.ts`:

```ts
import { getTestServer } from "@server/test/support";

const server = getTestServer();

describe("artifacts.serve routing", () => {
  it("captures the token and the file path from the URL", async () => {
    const res = await server.get("/api/artifacts.serve/tok123/css/app.css", {
      headers: { host: "sandbox.test" },
    });
    // The skeleton echoes what it parsed; real behaviour arrives in Task 6.
    expect(res.status).toBe(404);
    expect(res.body.debug).toEqual({ token: "tok123", path: "css/app.css" });
  });
});
```

Match the exact `server.get` call style used in `plugins/pages-gate/server/api/pages.test.ts`; adjust the call shape only, not the assertions.

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test plugins/artifacts/server/api/artifacts.test.ts`
Expected: FAIL (route not found / plugin missing).

- [ ] **Step 3: Write the minimal implementation**

`plugins/artifacts/plugin.json`:

```json
{
  "id": "artifacts",
  "name": "Artifacts",
  "priority": 0,
  "description": "Run interactive HTML artifacts inside documents on an isolated origin."
}
```

`plugins/artifacts/server/env.ts`:

```ts
import { IsBoolean, IsOptional } from "class-validator";
import { Environment } from "@server/env";
import { Public } from "@server/utils/decorators/Public";
import environment from "@server/utils/environment";

class ArtifactsPluginEnvironment extends Environment {
  /** Cloudflare account that owns the artifacts bucket. */
  @IsOptional()
  public ARTIFACTS_R2_ACCOUNT_ID = this.toOptionalString(
    environment.ARTIFACTS_R2_ACCOUNT_ID
  );

  /** R2 access key id with read and write on the artifacts bucket only. */
  @IsOptional()
  public ARTIFACTS_R2_ACCESS_KEY_ID = this.toOptionalString(
    environment.ARTIFACTS_R2_ACCESS_KEY_ID
  );

  /** R2 secret access key. */
  @IsOptional()
  public ARTIFACTS_R2_SECRET_ACCESS_KEY = this.toOptionalString(
    environment.ARTIFACTS_R2_SECRET_ACCESS_KEY
  );

  /** Name of the private artifacts bucket. */
  @IsOptional()
  public ARTIFACTS_R2_BUCKET = this.toOptionalString(
    environment.ARTIFACTS_R2_BUCKET
  );

  /** Hostname that serves artifact bytes, e.g. `tin-usercontent.net`. Never a tin.info host. */
  @IsOptional()
  public ARTIFACTS_SANDBOX_HOST = this.toOptionalString(
    environment.ARTIFACTS_SANDBOX_HOST
  );

  /** At least 32 characters; signs the 15-minute access tokens. */
  @IsOptional()
  public ARTIFACTS_TOKEN_SECRET = this.toOptionalString(
    environment.ARTIFACTS_TOKEN_SECRET
  );

  /** True only when every setting above is configured and the secret is long enough. */
  @Public
  @IsOptional()
  @IsBoolean()
  public ARTIFACTS_ENABLED =
    [
      this.ARTIFACTS_R2_ACCOUNT_ID,
      this.ARTIFACTS_R2_ACCESS_KEY_ID,
      this.ARTIFACTS_R2_SECRET_ACCESS_KEY,
      this.ARTIFACTS_R2_BUCKET,
      this.ARTIFACTS_SANDBOX_HOST,
      this.ARTIFACTS_TOKEN_SECRET,
    ].every(Boolean) && (this.ARTIFACTS_TOKEN_SECRET?.length ?? 0) >= 32;
}

export default new ArtifactsPluginEnvironment();
```

`plugins/artifacts/server/api/artifacts.ts` (skeleton; the debug echo is deleted in Task 6):

```ts
import Router from "koa-router";

const router = new Router();

router.get("artifacts.serve/:token/(.*)", async (ctx) => {
  ctx.status = 404;
  ctx.body = { debug: { token: ctx.params.token, path: ctx.params[0] } };
});

export default router;
```

`plugins/artifacts/server/index.ts`:

```ts
import { Hook, PluginManager } from "@server/utils/PluginManager";
import config from "../plugin.json";
import artifacts from "./api/artifacts";
import env from "./env";

if (env.ARTIFACTS_ENABLED) {
  PluginManager.add([{ ...config, type: Hook.API, value: artifacts }]);
}
```

For this task only, the test environment needs the plugin enabled: set the six `ARTIFACTS_*` values in `.env.test` (local DB file, never `.env`), secret of 32+ characters, and confirm A1 from the green test.

- [ ] **Step 4: Run it to verify it passes**

Run: `yarn test plugins/artifacts/server/api/artifacts.test.ts`
Expected: PASS. If `ctx.params[0]` is undefined, A1 is false for the wildcard: switch the route to `artifacts.serve/:token/:path+` and re-run; if params do not work at all, STOP and report (the serve design needs a Caddy rewrite to query parameters instead).

- [ ] **Step 5: Commit**

```bash
git add plugins/artifacts
git commit -m "feat(artifacts): plugin skeleton with env gate and serve route params"
```

---

### Task 2: Object keys and access tokens

**Files:**
- Create: `plugins/artifacts/server/lib/keys.ts`
- Create: `plugins/artifacts/server/lib/token.ts`
- Test: `plugins/artifacts/server/lib/keys.test.ts`, `plugins/artifacts/server/lib/token.test.ts`

**Interfaces:**
- Consumes: Node `crypto`.
- Produces:
  - `versionPrefix(teamId: string, artifactId: string, versionId: string): string`, which returns `artifacts/<teamId>/<artifactId>/<versionId>/` and throws `Error` unless every id is a UUID.
  - `assertSafePath(path: string): string`, which returns the path or throws `Error`.
  - `objectKey(prefix: string, path: string): string`.
  - `signToken(secret: string, claims: { versionId: string; teamId: string }, now?: number): string`.
  - `verifyToken(secret: string, token: string, now?: number): { versionId: string; teamId: string } | null`.
  - `TOKEN_TTL_MS = 15 * 60 * 1000`.

- [ ] **Step 1: Write the failing tests**

`keys.test.ts`:

```ts
import { assertSafePath, objectKey, versionPrefix } from "./keys";

const uuid = "11111111-1111-4111-8111-111111111111";

describe("versionPrefix", () => {
  it("builds the team-scoped prefix", () => {
    expect(versionPrefix(uuid, uuid, uuid)).toBe(
      `artifacts/${uuid}/${uuid}/${uuid}/`
    );
  });
  it("rejects ids that are not uuids", () => {
    expect(() => versionPrefix("../x", uuid, uuid)).toThrow();
  });
});

describe("assertSafePath", () => {
  it.each([
    "../x",
    "a/../../b",
    "/etc/passwd",
    "a\\b",
    "a\0b",
    "",
    "a//b",
    "./a",
    "x".repeat(201),
  ])("rejects %j", (p) => {
    expect(() => assertSafePath(p)).toThrow();
  });
  it("accepts nested relative paths", () => {
    expect(assertSafePath("css/app.css")).toBe("css/app.css");
  });
  it("joins prefix and path", () => {
    expect(objectKey("artifacts/a/b/c/", "index.html")).toBe(
      "artifacts/a/b/c/index.html"
    );
  });
});
```

`token.test.ts`:

```ts
import { TOKEN_TTL_MS, signToken, verifyToken } from "./token";

const secret = "s".repeat(32);
const claims = {
  versionId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
};

describe("token", () => {
  it("round-trips", () => {
    expect(verifyToken(secret, signToken(secret, claims, 1000), 1000)).toEqual(
      claims
    );
  });
  it("expires after the ttl", () => {
    const t = signToken(secret, claims, 1000);
    expect(verifyToken(secret, t, 1000 + TOKEN_TTL_MS + 1)).toBeNull();
  });
  it("rejects a flipped signature byte", () => {
    const t = signToken(secret, claims, 1000);
    const bad = t.slice(0, -1) + (t.endsWith("A") ? "B" : "A");
    expect(verifyToken(secret, bad, 1000)).toBeNull();
  });
  it("rejects a different secret", () => {
    const t = signToken(secret, claims, 1000);
    expect(verifyToken("x".repeat(32), t, 1000)).toBeNull();
  });
  it("rejects garbage without throwing", () => {
    expect(verifyToken(secret, "not.a.token", 1000)).toBeNull();
    expect(verifyToken(secret, "", 1000)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test plugins/artifacts/server/lib/keys.test.ts plugins/artifacts/server/lib/token.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Write the minimal implementation**

`keys.ts`:

```ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PATH_LENGTH = 200;

/**
 * Builds the object-storage prefix for one artifact version.
 *
 * @param teamId the owning team id.
 * @param artifactId the artifact id.
 * @param versionId the version id.
 * @returns `artifacts/<teamId>/<artifactId>/<versionId>/`.
 * @throws when any id is not a UUID.
 */
export function versionPrefix(
  teamId: string,
  artifactId: string,
  versionId: string
): string {
  for (const id of [teamId, artifactId, versionId]) {
    if (!UUID.test(id)) {
      throw new Error("Artifact ids must be UUIDs");
    }
  }
  return `artifacts/${teamId}/${artifactId}/${versionId}/`;
}

/**
 * Validates a relative file path from an uploaded bundle.
 *
 * @param path the path as it appeared in the bundle.
 * @returns the same path.
 * @throws when the path is empty, absolute, traverses, contains a backslash,
 * NUL, `.` or empty segments, or is longer than 200 characters.
 */
export function assertSafePath(path: string): string {
  if (!path || path.length > MAX_PATH_LENGTH) {
    throw new Error("Invalid artifact file path");
  }
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error("Invalid artifact file path");
  }
  for (const segment of path.split("/")) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error("Invalid artifact file path");
    }
  }
  return path;
}

/**
 * Joins a version prefix and a validated relative path.
 *
 * @param prefix the version prefix from `versionPrefix`.
 * @param path a path already accepted by `assertSafePath`.
 * @returns the full object key.
 */
export function objectKey(prefix: string, path: string): string {
  return `${prefix}${assertSafePath(path)}`;
}
```

`token.ts`:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

/** How long an access token stays valid. */
export const TOKEN_TTL_MS = 15 * 60 * 1000;

interface Claims {
  versionId: string;
  teamId: string;
}

function mac(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

/**
 * Signs a short-lived access token for one artifact version.
 *
 * @param secret the HMAC secret.
 * @param claims the version and team the token grants.
 * @param now the current time in ms, injectable for tests.
 * @returns `base64url(payload).base64url(signature)`.
 */
export function signToken(
  secret: string,
  claims: Claims,
  now: number = Date.now()
): string {
  const body = Buffer.from(
    JSON.stringify({ ...claims, exp: now + TOKEN_TTL_MS })
  ).toString("base64url");
  return `${body}.${mac(secret, body).toString("base64url")}`;
}

/**
 * Verifies a token.
 *
 * @param secret the HMAC secret.
 * @param token the token from the URL.
 * @param now the current time in ms, injectable for tests.
 * @returns the claims, or null for anything malformed, forged or expired.
 */
export function verifyToken(
  secret: string,
  token: string,
  now: number = Date.now()
): Claims | null {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) {
    return null;
  }
  const expected = mac(secret, body);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString());
    if (
      typeof parsed.versionId === "string" &&
      typeof parsed.teamId === "string" &&
      typeof parsed.exp === "number" &&
      parsed.exp > now
    ) {
      return { versionId: parsed.versionId, teamId: parsed.teamId };
    }
  } catch {
    return null;
  }
  return null;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `yarn test plugins/artifacts/server/lib/keys.test.ts plugins/artifacts/server/lib/token.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/artifacts/server/lib/keys.ts plugins/artifacts/server/lib/keys.test.ts plugins/artifacts/server/lib/token.ts plugins/artifacts/server/lib/token.test.ts
git commit -m "feat(artifacts): object key guard and HMAC access tokens"
```

---

### Task 3: Bundle validation (HTML file or zip)

**Files:**
- Create: `plugins/artifacts/server/lib/bundle.ts`
- Test: `plugins/artifacts/server/lib/bundle.test.ts`

**Interfaces:**
- Consumes: `assertSafePath` from `./keys`; `yauzl` (`fromBuffer`).
- Produces:
  - `interface BundleFile { path: string; body: Buffer; contentType: string }`.
  - `readBundle(fileName: string, bytes: Buffer): Promise<{ kind: "html" | "bundle"; files: BundleFile[] }>`; throws `BundleError` (exported class, `message` is user-safe).
  - Limits exported as `BUNDLE_LIMITS = { totalBytes: 25 * 1024 * 1024, files: 200, fileBytes: 10 * 1024 * 1024 }`.

- [ ] **Step 1: Write the failing tests**

`bundle.test.ts` builds zips in memory with a tiny local helper (store method, no compression) so no new dev dependency is needed:

```ts
import { BUNDLE_LIMITS, BundleError, readBundle } from "./bundle";

/** Builds a stored (uncompressed) zip. Entry names are written verbatim. */
function zip(entries: Record<string, string | Buffer>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const nameBuf = Buffer.from(name);
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(body.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return ~c >>> 0;
}

describe("readBundle", () => {
  it("accepts a single html file as index.html", async () => {
    const out = await readBundle("demo.html", Buffer.from("<h1>hi</h1>"));
    expect(out.kind).toBe("html");
    expect(out.files).toHaveLength(1);
    expect(out.files[0]).toMatchObject({
      path: "index.html",
      contentType: "text/html; charset=utf-8",
    });
  });

  it("accepts a zip with index.html and assets", async () => {
    const out = await readBundle(
      "site.zip",
      zip({ "index.html": "<p>x</p>", "css/app.css": "a{}" })
    );
    expect(out.kind).toBe("bundle");
    expect(out.files.map((f) => f.path).sort()).toEqual([
      "css/app.css",
      "index.html",
    ]);
  });

  it("rejects a zip without index.html", async () => {
    await expect(
      readBundle("s.zip", zip({ "a.html": "x" }))
    ).rejects.toBeInstanceOf(BundleError);
  });

  it.each(["../evil.html", "/abs.html", "a\\b.html", "ok/../../x.html"])(
    "rejects traversal entry %j",
    async (name) => {
      await expect(
        readBundle("s.zip", zip({ "index.html": "x", [name]: "y" }))
      ).rejects.toBeInstanceOf(BundleError);
    }
  );

  it("rejects an extension outside the allowlist", async () => {
    await expect(
      readBundle("s.zip", zip({ "index.html": "x", "run.exe": "MZ" }))
    ).rejects.toBeInstanceOf(BundleError);
  });

  it("rejects too many files", async () => {
    const entries: Record<string, string> = { "index.html": "x" };
    for (let i = 0; i < BUNDLE_LIMITS.files; i++) {
      entries[`f${i}.txt`] = "x";
    }
    await expect(readBundle("s.zip", zip(entries))).rejects.toBeInstanceOf(
      BundleError
    );
  });

  it("rejects a file over the per-file limit", async () => {
    const big = Buffer.alloc(BUNDLE_LIMITS.fileBytes + 1, 1);
    await expect(
      readBundle("s.zip", zip({ "index.html": "x", "big.txt": big }))
    ).rejects.toBeInstanceOf(BundleError);
  });

  it("rejects unknown top-level file types", async () => {
    await expect(readBundle("a.pdf", Buffer.from("x"))).rejects.toBeInstanceOf(
      BundleError
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test plugins/artifacts/server/lib/bundle.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the minimal implementation**

```ts
import yauzl from "yauzl";
import { assertSafePath } from "./keys";

/** Hard ceilings for an uploaded artifact. */
export const BUNDLE_LIMITS = {
  totalBytes: 25 * 1024 * 1024,
  files: 200,
  fileBytes: 10 * 1024 * 1024,
};

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm",
};

/** One validated file of an artifact version. */
export interface BundleFile {
  path: string;
  body: Buffer;
  contentType: string;
}

/** A validation failure whose message is safe to show the user. */
export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const type = CONTENT_TYPES[ext];
  if (!type) {
    throw new BundleError(`File type not allowed: ${path}`);
  }
  return type;
}

function readEntries(bytes: Buffer): Promise<BundleFile[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(new BundleError("The zip file could not be read"));
        return;
      }
      const files: BundleFile[] = [];
      let total = 0;
      zipfile.on("error", () => reject(new BundleError("Corrupt zip file")));
      zipfile.on("end", () => resolve(files));
      zipfile.on("entry", (entry: yauzl.Entry) => {
        try {
          if (entry.fileName.endsWith("/")) {
            zipfile.readEntry();
            return;
          }
          if (files.length >= BUNDLE_LIMITS.files) {
            throw new BundleError("Too many files in the bundle");
          }
          const path = assertSafePath(entry.fileName);
          const contentType = contentTypeFor(path);
          if (entry.uncompressedSize > BUNDLE_LIMITS.fileBytes) {
            throw new BundleError(`File too large: ${path}`);
          }
          total += entry.uncompressedSize;
          if (total > BUNDLE_LIMITS.totalBytes) {
            throw new BundleError("The bundle is too large");
          }
          zipfile.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) {
              reject(new BundleError(`Could not read ${path}`));
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            stream.on("data", (chunk: Buffer) => {
              size += chunk.length;
              // The header size can lie; the real bytes decide.
              if (size > BUNDLE_LIMITS.fileBytes) {
                stream.destroy();
                reject(new BundleError(`File too large: ${path}`));
                return;
              }
              chunks.push(chunk);
            });
            stream.on("error", () =>
              reject(new BundleError(`Could not read ${path}`))
            );
            stream.on("end", () => {
              files.push({ path, body: Buffer.concat(chunks), contentType });
              zipfile.readEntry();
            });
          });
        } catch (e) {
          zipfile.close();
          reject(e instanceof BundleError ? e : new BundleError("Invalid bundle"));
        }
      });
      zipfile.readEntry();
    });
  });
}

/**
 * Validates an uploaded artifact and returns its files.
 *
 * @param fileName the original upload name, used to pick html or zip.
 * @param bytes the file contents.
 * @returns the kind and the validated files, always including `index.html`.
 * @throws {BundleError} when the upload is not an allowed single HTML file
 * or a zip of allowed static files with an `index.html`.
 */
export async function readBundle(
  fileName: string,
  bytes: Buffer
): Promise<{ kind: "html" | "bundle"; files: BundleFile[] }> {
  if (bytes.length > BUNDLE_LIMITS.totalBytes) {
    throw new BundleError("The file is too large");
  }
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return {
      kind: "html",
      files: [
        {
          path: "index.html",
          body: bytes,
          contentType: CONTENT_TYPES.html,
        },
      ],
    };
  }
  if (lower.endsWith(".zip")) {
    const files = await readEntries(bytes);
    if (!files.some((f) => f.path === "index.html")) {
      throw new BundleError("The zip must contain index.html at its top level");
    }
    return { kind: "bundle", files };
  }
  throw new BundleError("Upload a .html file or a .zip of a static site");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `yarn test plugins/artifacts/server/lib/bundle.test.ts`
Expected: PASS. If `import yauzl from "yauzl"` fails typing, check how `server/` already imports it (`grep -rn "from \"yauzl\"" server shared`) and match.

- [ ] **Step 5: Commit**

```bash
git add plugins/artifacts/server/lib/bundle.ts plugins/artifacts/server/lib/bundle.test.ts
git commit -m "feat(artifacts): validate html and zip bundles"
```

---

### Task 4: Migration and models

**Files:**
- Create: `server/migrations/20261015120000-create-artifacts-tables.js`
- Create: `server/models/Artifact.ts`
- Create: `server/models/ArtifactVersion.ts`
- Modify: `server/models/index.ts` (append two export lines, same position style as `PagesSite`)
- Test: `server/models/Artifact.test.ts`

**Interfaces:**
- Consumes: `IdModel` from `./base/IdModel`; `Team`, `User`, `Document`.
- Produces:
  - `Artifact` with `teamId`, `documentId`, `createdById`, `title: string`, `currentVersionId: string | null`, `deletedAt: Date | null`.
  - `ArtifactVersion` with `artifactId`, `teamId`, `kind: "html" | "bundle"`, `sha256: string`, `sizeBytes: number`, `fileCount: number`, `sourceAttachmentId: string | null`, `createdById`.

- [ ] **Step 1: Write the failing test**

```ts
import { buildDocument, buildUser } from "@server/test/factories";
import { Artifact, ArtifactVersion } from "@server/models";

describe("Artifact", () => {
  it("persists an artifact and its version", async () => {
    const user = await buildUser();
    const document = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
    });
    const artifact = await Artifact.create({
      teamId: user.teamId,
      documentId: document.id,
      createdById: user.id,
      title: "Demo",
    });
    const version = await ArtifactVersion.create({
      artifactId: artifact.id,
      teamId: user.teamId,
      kind: "html",
      sha256: "a".repeat(64),
      sizeBytes: 10,
      fileCount: 1,
      createdById: user.id,
    });
    await artifact.update({ currentVersionId: version.id });
    const found = await Artifact.findByPk(artifact.id);
    expect(found?.currentVersionId).toBe(version.id);
    expect(found?.deletedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test server/models/Artifact.test.ts`
Expected: FAIL (`Artifact` is not exported).

- [ ] **Step 3: Write the migration and models**

Migration (same helper style as `20261013125333-create-pages-tables.js`):

```js
"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const id = {
        type: Sequelize.UUID,
        allowNull: false,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      };
      const ref = (model, onDelete, allowNull = false) => ({
        type: Sequelize.UUID,
        allowNull,
        references: { model, key: "id" },
        onDelete,
      });
      const stamps = {
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      };

      await queryInterface.createTable(
        "artifacts",
        {
          id,
          teamId: ref("teams", "CASCADE"),
          documentId: ref("documents", "CASCADE"),
          createdById: ref("users", "CASCADE"),
          title: { type: Sequelize.STRING, allowNull: false },
          currentVersionId: { type: Sequelize.UUID, allowNull: true },
          deletedAt: { type: Sequelize.DATE, allowNull: true },
          ...stamps,
        },
        { transaction }
      );
      await queryInterface.addIndex("artifacts", ["teamId"], { transaction });
      await queryInterface.addIndex("artifacts", ["documentId"], { transaction });

      await queryInterface.createTable(
        "artifact_versions",
        {
          id,
          artifactId: ref("artifacts", "CASCADE"),
          teamId: ref("teams", "CASCADE"),
          kind: { type: Sequelize.STRING, allowNull: false },
          sha256: { type: Sequelize.STRING(64), allowNull: false },
          sizeBytes: { type: Sequelize.BIGINT, allowNull: false },
          fileCount: { type: Sequelize.INTEGER, allowNull: false },
          sourceAttachmentId: { type: Sequelize.UUID, allowNull: true },
          createdById: ref("users", "CASCADE"),
          ...stamps,
        },
        { transaction }
      );
      await queryInterface.addIndex("artifact_versions", ["artifactId"], {
        transaction,
      });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("artifact_versions", { transaction });
      await queryInterface.dropTable("artifacts", { transaction });
    });
  },
};
```

`server/models/Artifact.ts`:

```ts
import type { InferAttributes, InferCreationAttributes } from "sequelize";
import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  HasMany,
  Table,
} from "sequelize-typescript";
import ArtifactVersion from "./ArtifactVersion";
import Document from "./Document";
import Team from "./Team";
import User from "./User";
import IdModel from "./base/IdModel";

@Table({
  tableName: "artifacts",
  modelName: "artifact",
  indexes: [{ fields: ["teamId"] }, { fields: ["documentId"] }],
})
class Artifact extends IdModel<
  InferAttributes<Artifact>,
  Partial<InferCreationAttributes<Artifact>>
> {
  @Column(DataType.STRING)
  title: string;

  /** The version the opener serves; null until the first version is stored. */
  @Column(DataType.UUID)
  currentVersionId: string | null;

  @Column(DataType.DATE)
  deletedAt: Date | null;

  @BelongsTo(() => Team, "teamId")
  team: Team;

  @ForeignKey(() => Team)
  @Column(DataType.UUID)
  teamId: string;

  @BelongsTo(() => Document, "documentId")
  document: Document;

  @ForeignKey(() => Document)
  @Column(DataType.UUID)
  documentId: string;

  @BelongsTo(() => User, "createdById")
  createdBy: User;

  @ForeignKey(() => User)
  @Column(DataType.UUID)
  createdById: string;

  @HasMany(() => ArtifactVersion, "artifactId")
  versions: ArtifactVersion[];
}

export default Artifact;
```

`server/models/ArtifactVersion.ts`: same shape: `kind: string`, `sha256: string`, `sizeBytes: number` (`DataType.BIGINT`), `fileCount: number`, `sourceAttachmentId: string | null`, `@BelongsTo(() => Artifact, "artifactId")`, `@ForeignKey(() => Artifact) artifactId`, `teamId`, `createdById`, table `artifact_versions`, model name `artifactVersion`, indexes on `artifactId`.

`server/models/index.ts`: add `export { default as Artifact } from "./Artifact";` and `export { default as ArtifactVersion } from "./ArtifactVersion";` next to the existing `PagesSite` export.

- [ ] **Step 4: Run migration and test**

Run: `yarn db:migrate --env=test` (only against the `.env.test` local DB), then `yarn test server/models/Artifact.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/migrations/20261015120000-create-artifacts-tables.js server/models/Artifact.ts server/models/ArtifactVersion.ts server/models/index.ts server/models/Artifact.test.ts
git commit -m "feat(artifacts): artifacts and artifact_versions tables"
```

---

### Task 5: API (create, info, delete, open) with document-level authorization

**Files:**
- Create: `plugins/artifacts/server/lib/store.ts`
- Create: `plugins/artifacts/server/api/schema.ts`
- Modify: `plugins/artifacts/server/api/artifacts.ts`
- Test: `plugins/artifacts/server/api/artifacts.test.ts` (extend)

**Interfaces:**
- Consumes: `readBundle`, `versionPrefix`, `objectKey`, `signToken`, `env`, `createR2Client`/`createR2Store`/`ObjectStore` (from `../../../pages-gate/server/lib/objectStore`), models `Artifact`, `ArtifactVersion`, `Document`, `Attachment`.
- Produces:
  - `getArtifactStore(): ObjectStore` in `store.ts` (lazy singleton; test override via `setArtifactStoreForTests(store: ObjectStore | null)`).
  - Routes: `POST /api/artifacts.create { documentId, attachmentId, title?, id? }` returns `{ data: { id, title, currentVersionId, openUrl } }`; `POST /api/artifacts.info { id }`; `POST /api/artifacts.delete { id }`; `GET /api/artifacts.open?id=` returns 302 to `https://<ARTIFACTS_SANDBOX_HOST>/a/<token>/index.html`.
  - `openUrl` format: `${env.URL}/api/artifacts.open?id=<artifactId>`.

- [ ] **Step 1: Verify A5 and A6 before writing handlers**

Run: `grep -n "getFileBuffer" server/storage/files/BaseStorage.ts server/storage/files/index.ts` and read how `attachments.redirect` (`server/routes/api/attachments/attachments.ts:304`) authenticates and how `FileStorage` is imported there. Use the same import. If `getFileBuffer` is not on `FileStorage`, use `getFileStream` and collect chunks. If a `GET` route cannot authenticate by session cookie with `auth({ type: AuthenticationType.APP })`, STOP and report; the opener design needs a different entry.

- [ ] **Step 2: Write the failing tests**

Add to `artifacts.test.ts` (use `setArtifactStoreForTests` with an in-memory store; copy the shape of `plugins/pages-gate/server/test/memoryStore.ts` by importing it: `import { createMemoryStore } from "../../../pages-gate/server/test/memoryStore"` if it exports one, otherwise inline a 20-line Map-backed `ObjectStore`):

```ts
describe("artifacts.create", () => {
  it("stores a version and returns the open url", async () => { /* upload attachment with html bytes, create, expect 200, data.currentVersionId set, store has index.html */ });
  it("requires update permission on the document", async () => { /* viewer-only user -> 403 */ });
  it("rejects a document from another team", async () => { /* other team's doc -> 403 or 404, nothing written */ });
  it("rejects an attachment that belongs to another document", async () => {});
  it("surfaces BundleError as a 400 with the message", async () => {});
});

describe("artifacts.open", () => {
  it("redirects a reader to the sandbox host with a token", async () => {
    /* Location starts with https://<host>/a/ and ends with /index.html */
  });
  it("returns 403 for a user without read on the document", async () => {});
  it("returns 404 for another team's artifact", async () => {});
  it("returns 404 once the artifact is deleted", async () => {});
});

describe("artifacts.delete", () => {
  it("soft deletes and requires update on the document", async () => {});
});
```

Each `it` gets a real body in the same style as `pages.test.ts` (factories `buildUser`, `buildDocument`, `buildAttachment`, `buildTeam`, `buildCollection`; a second team for isolation cases). Do not leave any body empty.

- [ ] **Step 3: Run to verify they fail**

Run: `yarn test plugins/artifacts/server/api/artifacts.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

`store.ts`:

```ts
import {
  type ObjectStore,
  createR2Client,
  createR2Store,
} from "../../../pages-gate/server/lib/objectStore";
import env from "../env";

let override: ObjectStore | null = null;
let cached: ObjectStore | null = null;

/**
 * Returns the artifacts bucket store.
 *
 * @returns the R2 store, or the test override.
 * @throws when the plugin is not fully configured.
 */
export function getArtifactStore(): ObjectStore {
  if (override) {
    return override;
  }
  if (!cached) {
    const { ARTIFACTS_R2_ACCOUNT_ID, ARTIFACTS_R2_ACCESS_KEY_ID,
      ARTIFACTS_R2_SECRET_ACCESS_KEY, ARTIFACTS_R2_BUCKET } = env;
    if (!ARTIFACTS_R2_ACCOUNT_ID || !ARTIFACTS_R2_ACCESS_KEY_ID ||
      !ARTIFACTS_R2_SECRET_ACCESS_KEY || !ARTIFACTS_R2_BUCKET) {
      throw new Error("Artifacts storage is not configured");
    }
    cached = createR2Store({
      client: createR2Client({
        accountId: ARTIFACTS_R2_ACCOUNT_ID,
        accessKeyId: ARTIFACTS_R2_ACCESS_KEY_ID,
        secretAccessKey: ARTIFACTS_R2_SECRET_ACCESS_KEY,
      }),
      bucket: ARTIFACTS_R2_BUCKET,
    });
  }
  return cached;
}

/**
 * Replaces the store in tests.
 *
 * @param store the in-memory store, or null to restore the default.
 */
export function setArtifactStoreForTests(store: ObjectStore | null): void {
  override = store;
}
```

`artifacts.ts` handlers (names and imports follow `plugins/pages-gate/server/api/pages.ts`):

```ts
router.post(
  "artifacts.create",
  auth({ type: [AuthenticationType.APP, AuthenticationType.API] }),
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  validate(T.ArtifactsCreateSchema),
  async (ctx: APIContext<T.ArtifactsCreateReq>) => {
    const { documentId, attachmentId, title, id } = ctx.input.body;
    const { user } = ctx.state.auth;

    const document = await Document.findByPk(documentId, { userId: user.id });
    authorize(user, "update", document);

    const attachment = await Attachment.findOne({
      where: { id: attachmentId, teamId: user.teamId, documentId: document.id },
    });
    if (!attachment) {
      throw NotFoundError("Attachment not found");
    }

    const bytes = await FileStorage.getFileBuffer(attachment.key);
    let bundle;
    try {
      bundle = await readBundle(attachment.name, bytes);
    } catch (err) {
      if (err instanceof BundleError) {
        throw ValidationError(err.message);
      }
      throw err;
    }

    const store = getArtifactStore();
    const versionId = randomUUID();
    const existing = id
      ? await Artifact.findOne({
          where: { id, teamId: user.teamId, documentId: document.id, deletedAt: null },
        })
      : null;
    if (id && !existing) {
      throw NotFoundError("Artifact not found");
    }
    const artifactId = existing?.id ?? randomUUID();
    const prefix = versionPrefix(user.teamId, artifactId, versionId);

    // Write bytes first: a failed upload leaves unreferenced objects only.
    for (const file of bundle.files) {
      await store.put(objectKey(prefix, file.path), file.body, {
        contentType: file.contentType,
        cacheControl: "private, max-age=0, no-store",
      });
    }

    const sha256 = createHash("sha256")
      .update(Buffer.concat(bundle.files.map((f) => f.body)))
      .digest("hex");
    const sizeBytes = bundle.files.reduce((n, f) => n + f.body.length, 0);

    const artifact = await sequelize.transaction(async (transaction) => {
      const row =
        existing ??
        (await Artifact.create(
          {
            id: artifactId,
            teamId: user.teamId,
            documentId: document.id,
            createdById: user.id,
            title: title ?? attachment.name,
          },
          { transaction }
        ));
      await ArtifactVersion.create(
        {
          id: versionId,
          artifactId: row.id,
          teamId: user.teamId,
          kind: bundle.kind,
          sha256,
          sizeBytes,
          fileCount: bundle.files.length,
          sourceAttachmentId: attachment.id,
          createdById: user.id,
        },
        { transaction }
      );
      await row.update({ currentVersionId: versionId }, { transaction });
      return row;
    });

    ctx.body = { data: presentArtifact(artifact) };
  }
);
```

`artifacts.open` (never calls `authorize` on the team alone):

```ts
router.get(
  "artifacts.open",
  auth({ type: AuthenticationType.APP }),
  rateLimiter(RateLimiterStrategy.OneHundredPerMinute),
  async (ctx) => {
    const { user } = ctx.state.auth;
    const id = String(ctx.query.id ?? "");
    const artifact = await Artifact.findOne({
      where: { id, teamId: user.teamId, deletedAt: null },
    });
    if (!artifact || !artifact.currentVersionId) {
      throw NotFoundError("Artifact not found");
    }
    const document = await Document.findByPk(artifact.documentId, {
      userId: user.id,
    });
    authorize(user, "read", document);

    const token = signToken(env.ARTIFACTS_TOKEN_SECRET ?? "", {
      versionId: artifact.currentVersionId,
      teamId: artifact.teamId,
    });
    ctx.set("Cache-Control", "no-store");
    ctx.set("Referrer-Policy", "no-referrer");
    ctx.redirect(`https://${env.ARTIFACTS_SANDBOX_HOST}/a/${token}/index.html`);
  }
);
```

`artifacts.delete` and `artifacts.info` follow the same lookup (`teamId` + `deletedAt: null`), authorize `update`/`read` on the document, and delete sets `deletedAt: new Date()`.

`presentArtifact(a)` returns `{ id, title, currentVersionId, documentId, openUrl: \`${env.URL}/api/artifacts.open?id=${a.id}\` }` (import `env` from `@server/env` here, not the plugin env).

`schema.ts`: zod schemas `ArtifactsCreateSchema` (`documentId`, `attachmentId` UUIDs, optional `title` max 200, optional `id` UUID), `ArtifactsInfoSchema`, `ArtifactsDeleteSchema`, each wrapped in `BaseSchema` exactly as `plugins/pages-gate/server/api/schema.ts` does.

- [ ] **Step 5: Run to verify they pass**

Run: `yarn test plugins/artifacts/server/api/artifacts.test.ts`
Expected: PASS for every `describe` above.

- [ ] **Step 6: Commit**

```bash
git add plugins/artifacts server/models
git commit -m "feat(artifacts): create, info, delete and open with document authorization"
```

---

### Task 6: Serve route and response headers

**Files:**
- Create: `plugins/artifacts/server/lib/headers.ts`
- Test: `plugins/artifacts/server/lib/headers.test.ts`
- Modify: `plugins/artifacts/server/api/artifacts.ts` (replace the Task 1 skeleton `serve`)
- Test: `plugins/artifacts/server/api/artifacts.test.ts` (extend)

**Interfaces:**
- Consumes: `verifyToken`, `versionPrefix`, `objectKey`, `getArtifactStore`, `Artifact`, `ArtifactVersion`, `env`.
- Produces: `artifactHeaders(frameAncestors: string[]): Record<string, string>`; `GET /api/artifacts.serve/:token/(.*)` streaming the file; empty path means `index.html`.

- [ ] **Step 1: Write the failing tests**

`headers.test.ts`:

```ts
import { artifactHeaders } from "./headers";

describe("artifactHeaders", () => {
  const h = artifactHeaders(["https://docs.tin.info", "https://*.docs.tin.info"]);
  it("sandboxes without allow-same-origin", () => {
    const csp = h["Content-Security-Policy"];
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).not.toContain("allow-top-navigation");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain(
      "frame-ancestors https://docs.tin.info https://*.docs.tin.info"
    );
  });
  it("sets nosniff and no-referrer", () => {
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("no-referrer");
  });
});
```

Extend `artifacts.test.ts` (real bodies, same style):

```ts
describe("artifacts.serve", () => {
  it("streams index.html with sandbox headers for a valid token", async () => {});
  it("serves a nested asset path", async () => {});
  it("404s on the main app host", async () => {
    /* request with Host: the app host (env.URL host), valid token -> 404, no body bytes */
  });
  it("404s on an expired token", async () => {});
  it("404s when the token's team differs from the version's team", async () => {});
  it("404s for a soft-deleted artifact even with a valid token", async () => {});
  it("404s for a path outside the version prefix", async () => {
    /* ../ and encoded %2e%2e%2f variants */
  });
  it("never sets a cookie", async () => {});
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test plugins/artifacts/server/lib/headers.test.ts plugins/artifacts/server/api/artifacts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`headers.ts`:

```ts
/**
 * Response headers for artifact bytes. The `sandbox` directive gives the
 * document an opaque origin even when it is framed with allow-same-origin.
 *
 * @param frameAncestors origins allowed to frame the artifact.
 * @returns the header map.
 */
export function artifactHeaders(
  frameAncestors: string[]
): Record<string, string> {
  return {
    "Content-Security-Policy": [
      "sandbox allow-scripts allow-forms allow-popups allow-modals",
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "media-src 'self' data: blob:",
      "connect-src 'none'",
      `frame-ancestors ${frameAncestors.join(" ")}`,
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, max-age=900",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}
```

Serve handler in `artifacts.ts` (replaces the skeleton; no `auth` middleware, the token is the credential, mirroring the public `pages.ingest` precedent):

```ts
router.get(
  "artifacts.serve/:token/(.*)",
  rateLimiter(RateLimiterStrategy.OneThousandPerMinute),
  async (ctx) => {
    // Only the sandbox host may serve bytes. Never the app host.
    if (ctx.hostname !== env.ARTIFACTS_SANDBOX_HOST) {
      ctx.status = 404;
      return;
    }
    const claims = verifyToken(env.ARTIFACTS_TOKEN_SECRET ?? "", ctx.params.token);
    if (!claims) {
      ctx.status = 404;
      return;
    }
    const version = await ArtifactVersion.findOne({
      where: { id: claims.versionId, teamId: claims.teamId },
      include: [{ model: Artifact, required: true }],
    });
    if (!version || version.artifact.deletedAt || version.artifact.teamId !== claims.teamId) {
      ctx.status = 404;
      return;
    }
    let key: string;
    try {
      const path = ctx.params[0] || "index.html";
      key = objectKey(
        versionPrefix(claims.teamId, version.artifactId, version.id),
        decodeURIComponent(path)
      );
    } catch {
      ctx.status = 404;
      return;
    }
    const bytes = await getArtifactStore().get(key);
    if (!bytes) {
      ctx.status = 404;
      return;
    }
    const origin = new URL(coreEnv.URL);
    ctx.set(
      artifactHeaders([origin.origin, `${origin.protocol}//*.${origin.host}`])
    );
    ctx.type = contentTypeFromKey(key);
    ctx.body = Buffer.from(bytes);
  }
);
```

`contentTypeFromKey` reuses the extension map: export `CONTENT_TYPES` from `bundle.ts` as `contentTypeForPath(path)` and import it (do not duplicate the map). Add that export in this task and a one-line test.

- [ ] **Step 4: Run to verify they pass**

Run: `yarn test plugins/artifacts/server/lib/headers.test.ts plugins/artifacts/server/lib/bundle.test.ts plugins/artifacts/server/api/artifacts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/artifacts
git commit -m "feat(artifacts): serve route with sandbox headers and token checks"
```

---

### Task 7: Caddy vhost and operator notes

**Files:**
- Modify: `deploy/caddy/Caddyfile` (append one block)

**Interfaces:**
- Consumes: the `outline:3000` upstream already used by the main block.
- Produces: a vhost for `{env.ARTIFACTS_SANDBOX_HOST}` that forwards only `/a/*`.

- [ ] **Step 1: Append the block**

```caddy
# Isolated origin for user-uploaded interactive artifacts. A separate
# registrable domain on purpose: never a tin.info host, so cookies and
# SameSite rules cannot reach Outline. Only /a/* is forwarded, rewritten to the
# plugin's serve route; everything else is a 404. The plugin verifies the Host
# header itself and sets the sandbox CSP.
{env.ARTIFACTS_SANDBOX_HOST} {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}

	encode zstd gzip

	@artifact path /a/*
	handle @artifact {
		rewrite * /api/artifacts.serve{path}
		reverse_proxy outline:3000 {
			lb_try_duration 60s
			lb_try_interval 500ms
		}
	}

	handle {
		respond "Not found" 404
	}
}
```

Rewrite note: `/a/<token>/index.html` becomes `/api/artifacts.serve/<token>/index.html`, which is the route captured in Task 1.

- [ ] **Step 2: Validate syntax locally**

Run: `docker run --rm -v "$PWD/deploy/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" -e ARTIFACTS_SANDBOX_HOST=example.test -e CF_API_TOKEN=x -e ACME_EMAIL=a@b.c caddy:2 caddy validate --config /etc/caddy/Caddyfile`
Expected: "Valid configuration" (the DNS plugin may be missing from the stock image; if validate fails only on the `dns cloudflare` directive, note it and rely on the production image check in Task 8).

- [ ] **Step 3: Commit**

```bash
git add deploy/caddy/Caddyfile
git commit -m "feat(artifacts): caddy vhost for the isolated artifact origin"
```

---

### Task 8: Production verification (orchestrator, with the user)

Not delegated: touches production, DNS, secrets (routing rule 5).

- [ ] **Step 1: Operator prerequisites (user)**

1. A separate registrable domain, DNS in Cloudflare, `A` record to the Hetzner server (DNS only), same pattern as `docs.tin.info`.
2. A new private R2 bucket and a token with Object Read & Write scoped to that bucket only. Access key id is 32 hex, secret is 64 hex (the "Token value" is not the secret).
3. A 48+ character random `ARTIFACTS_TOKEN_SECRET`.
4. The six `ARTIFACTS_*` values in the production `.env` (compose `env_file: .env`).

- [ ] **Step 2: Deploy**

The Caddyfile is baked into the image: merge, let watchtower deploy, and confirm both the Outline container and Caddy picked up the new image. The migration runs on container start.

- [ ] **Step 3: End-to-end checks**

1. `curl -sI https://<sandbox-host>/` returns 404 with no app headers.
2. `curl -s https://<app-host>/api/artifacts.serve/x/index.html` returns 404 (host check).
3. Upload `demo.html` via `attachments.create` with a `documentId`, call `artifacts.create`, paste the returned `openUrl` into the document as an embed, and confirm it renders and animates for a reader.
4. As a user with no access to that document, open the `openUrl` directly: expect 403.
5. Repeat the Task 0 table from the real embed: `origin` is `null`, no cookie, `connect` blocked.
6. Delete the artifact; reload the document: embed fails closed.

- [ ] **Step 4: Record results and stop**

Post the table in the PR. Do not start the follow-up plans until the user reviews it.

---

## Out of scope for this plan (follow-up plans, in order)

1. **Editor UX:** `artifact` EmbedDescriptor before the generic one in `shared/editor/embeds/index.tsx` (title, icon, auto-height, iframe without `allow-same-origin`, `allowfullscreen`), plus a Settings → Artifacts list for upload and versions.
2. **Shared publishing core** (from the Pages publishing spec): `artifacts:*` and `pages:*` API-key scopes, presigned-PUT upload sessions with staging cleanup, MCP tools via a new plugin hook.
3. **Publish artifact to Pages:** copy a version into `sites/<slug>/`, gated by the sandboxed-iframe gate fix verified in a browser first.
4. **JSX/TSX build** (esbuild with an `onResolve` allowlist), `localStorage` shim, per-artifact `connect-src` allowlist, share tokens, restore and rollback endpoints, R2 purge task.

MVP limitations a user will notice: no upload UI (API and curl only), no auto-height, search sees only the embed URL, public share links show no artifact, and `localStorage` inside an artifact throws.

## Self-review

- **Spec coverage:** private storage (T2, T5), per-team prefix (T2), opener with document `read` (T5), separate origin + sandbox CSP (T6, T7), no core CSP/Frame changes (Global Constraints), lifecycle create/version/delete (T5; restore and purge deferred and listed), tenant isolation (T2, T5, T6), spike for unverified claims (T0). Gap noted openly: no UI and no restore in MVP.
- **Placeholder scan:** test bodies in Tasks 5 and 6 are listed by name and described, with the factory style to copy; the implementer must write them in full before Step 3 (they are the failing tests). If a reviewer wants them inline, expand during execution; this is the one place the plan leans on the neighboring `pages.test.ts`.
- **Type consistency:** `versionPrefix`, `objectKey`, `signToken`, `verifyToken`, `readBundle`, `BundleError`, `getArtifactStore`, `artifactHeaders`, `contentTypeForPath` are used with the same names and signatures across tasks.
- **Review Focus:** items 1-8 map to Tasks 3, 3, 2/6, 5, 5/6, 6, 6, 5.
