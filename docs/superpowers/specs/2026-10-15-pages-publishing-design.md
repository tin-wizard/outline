# Pages Publishing and Management: Design Spec

Status: draft (for review, no implementation yet)
Date: 2026-10-15
Scope: Make Pages the single place where published sites are created, seen
and removed; let Outline API keys publish from Claude, Cursor, Factory and
other IDEs without Wrangler; link published sites back to the knowledge base.
Base revision: `cb12bf9` (`origin/main`)

## 1. Goal

1. Every published page is visible in Pages, with counts, its address and a
   way to remove it, whether it was published from the web UI, an agent or a
   script.
2. An Outline API key, governed by the user's role, can publish. Agents never
   hold Cloudflare credentials, and a key can be limited to particular sites
   (folders).
3. File contents never pass through the model: an agent uploads bytes with
   `curl` to a pre-signed URL, and every model-visible call is small metadata.
4. A site can belong to a knowledge base document (its "home"), or stand
   alone.

## 2. Motivation

Publishing with Wrangler from an AI tool is slow and expensive. The file
contents, commands and retries all pass through the model. Wrangler also
keeps no record of what it published, so those objects never appear in Pages.
The slugs reserved in `plugins/pages-gate/server/lib/keys.ts`
(`platform-architecture`, `platform-onboarding`, `implexus-platform`) are
evidently objects published outside the panel.

Pitch's model is the reference for the agent interface. Its MCP tools never
carry file contents; an import happens in the app. Content (a presentation)
is separate from links. Links can be listed and updated, and each carries
options: passcode, expiry, disable, analytics and PDF download.

## 3. Current state

| Concern | Today |
| --- | --- |
| Who can manage sites | Admins and platform admins only (`plugins/pages-gate/server/policies.ts`) |
| Authentication | Browser session only: the Pages routes use `auth({ type: APP })`, so API keys and OAuth tokens are refused |
| What can be published | Outline documents and collections, rendered to HTML (max 50 documents) |
| Protection | Per-site switch. Protected pages are AES-GCM encrypted on the server and decrypted in the reader's browser with the code |
| Removal | Whole site only (`pages.unpublish`, `pages.delete`) |
| Visibility | One row per site; no page counts, no link to the knowledge base, no view of objects published elsewhere |
| Cloudflare credentials | Held only by the server (`PAGES_R2_*`) |
| Agent access to Outline | MCP server at `/mcp` accepts API keys and OAuth. Tools are filtered by scope but hard-coded in `server/routes/mcp/index.ts` |
| Cheap uploads | `create_attachment` MCP tool returns a pre-signed URL and a `curl` command |
| Scopes | The grammar already accepts `pages:read`, `pages:write` and `/api/pages.publish` (`shared/helpers/AuthenticationHelper.ts`) |

## 4. What is possible

| Requirement | Possible? | Notes |
| --- | --- | --- |
| An Outline API key publishes to R2 | Yes | The server publishes on the key's behalf with its own R2 credentials. The key never sees them |
| Limit a key or user to certain folders | Yes, enforced by Outline | Folder = site (`sites/<slug>/`). See section 5. On its own, R2 can scope temporary credentials to prefixes for up to 7 days, but per-object pre-signed URLs chosen by the server are narrower, so the agent never needs R2 credentials |
| Agent uploads without the bytes passing through the model | Yes | Pre-signed `PUT` URLs. R2 does not support pre-signed `POST` form uploads, so the flow must use `PUT`. `curl` needs no CORS; browser uploads need a bucket CORS rule |
| Direct-to-R2 upload for a **protected** site | No, not directly | Encryption happens on the server, so protected uploads go to a staging area first. The server then encrypts and writes the final objects. Public sites can be written in place |
| Uploaded HTML bundles with images, CSS and JS under today's protection | Partly | Only HTML is encrypted. Assets would be readable without the code unless inlined into the HTML, within size limits. Full protection for any file type needs the edge gate (Phase 3) |
| Publish rights by role (admin, member, viewer, guest) | Yes | Policy change plus site grants |
| Pages tools in the existing MCP server | Yes | Needs a small hook so a plugin can register MCP tools |
| List objects in the bucket that Pages does not know about | Yes | R2 supports S3 `ListObjectsV2`; the store already has `list(prefix)` |
| Live status of a site inside a knowledge base document | Yes | Outline's `Hook.UnfurlProvider` (used by the GitHub, GitLab and Figma plugins) can show a live card for a site URL |
| Pitch-style expiry, instant disable, per-link passcodes | Not with static encrypted files | Static files cannot expire or check a server. These need the edge gate (Phase 3). Until then, disabling a site means unpublishing it |
| View analytics | Already there | Pages has a measurement beacon and Insights |
| PowerPoint shown as a page | Later | Server-side conversion (for example, LibreOffice to PDF or images per slide). Out of scope for now |

## 5. Permissions

**Roles (proposal).** Admins can do everything on every site. Members can
create sites and publish to sites they own or have been granted. Viewers and
guests cannot publish.

**Site grants.** Each site has an owner (`createdById`) and optional grants to
users or groups with `publish` or `manage`. A site is the "folder" an agent
may write to.

**API keys.**
- A key acts as its user and needs a Pages scope: `pages:read`, `pages:write`,
  or route scopes such as `/api/pages.publish`.
- A key can carry an optional site allowlist. When set, the key can only touch
  those sites, even if its user can reach more.
- The Pages routes accept `API` and `OAUTH` authentication in addition to
  `APP`.
- Each upload URL is signed by the server for one exact object key under the
  site's prefix, so a key cannot write outside its site.

**Access codes over the API (recommendation).** An API or MCP caller either
sets the code itself (`newAccessCode`) or publishes a public site. Generated
codes are shown only in the web UI, so they never land in an agent's
transcript.

## 6. Proposed changes, in order

### Phase 1: visibility (no new access paths)

- **Pages screen.**
  - A totals line, such as "14 sites · 212 pages · 3 public · 2 standalone".
  - A Pages count column and a Home document column on the sites list.
- **Site detail.** A second level listing every page with its title, address,
  source, last published date and views, and actions to open, copy or remove
  it.
- **Remove one page.** A new `pages.removePage` route removes the object and
  its publication row without republishing the rest.
- **Home document.**
  - A nullable `pages_sites.documentId` (migration).
  - A picker on create and edit.
  - A live card in the document via an unfurl provider.
  - Sites with no home document are labelled Standalone.
- **Untracked in storage.**
  - Lists prefixes under `sites/` and at the bucket root that Pages has no
    record of, with their object counts and sizes.
  - Actions: delete, or adopt as an External site. An adopted site can be
    listed and removed, but not republished from the knowledge base.

### Phase 2: publishing from Claude and IDEs

- **Access.** Role-based policies, site grants, Pages scopes on API keys, and
  the optional per-key site allowlist.
- **Upload sessions.**
  1. `pages.uploadCreate { siteId, files: [{ path, size, contentType }] }`
     returns one pre-signed `PUT` per file, into staging.
  2. The caller uploads each file with `curl`.
  3. `pages.publish { id, uploadId }` checks the files and publishes them:
     encrypted for protected sites, as they are for public ones.
  4. Staging expires after 24 hours.

  Supported files: a single HTML file, a zipped static site, and PDF (served
  as a file).
- **MCP tools** (via a new plugin hook):
  - `list_sites`, `get_site`, `create_site`
  - `create_upload`, `publish_site`, `remove_page`
  - `unpublish_site`, `delete_site`, `rotate_code`
  - `set_home_document`
- **Skill and IDE rule.** A short "publish to Pages" skill for Claude and a
  matching rule for Cursor and Factory. Steps: build, `create_upload`, `curl`,
  `publish_site`, then `set_home_document` or add the link to the knowledge
  base document.
- **CLI.** For scripts and IDEs without MCP, using the same API and no model
  tokens:

  ```bash
  npx tin-pages publish ./dist --site sales --code-file ./code.txt
  ```

### Phase 3: edge gate and Pitch parity (decision needed)

- A Cloudflare Worker in front of the bucket checks the code and sets a signed
  cookie. This works for any file type and allows link expiry, instant
  disable, per-link codes, and visitor email where wanted.
- Trade-off: files are stored unencrypted, so privacy relies on the bucket
  being private. The current encrypted mode can remain an option for sensitive
  knowledge base content.
- PowerPoint to a viewable page.

## 7. Open questions

1. Do members get publish rights by default, or only admins until a site is
   granted to them?
2. Should API callers ever receive a generated code, or always set their own
   (the recommendation)?
3. Is the public pages host served by an R2 custom domain today, or already by
   a Worker? This decides how much of Phase 3 is new.
4. What should happen to untracked objects that are adopted? Do they keep
   their address, and who owns them?
5. Size limits for uploads (per file and per site)?

## 8. Risks

- **Codes in transcripts.** Mitigated by the code recommendation in section 5.
- **Staging left behind.** Needs a cleanup task, which can follow the pattern
  of the existing Pages cleanup task.
- **Leaking assets.** Uploaded assets on protected sites are readable without
  the code until Phase 3. The UI must warn about this, or inline the assets.
- **Deleting unknown objects.** Deleting untracked objects needs a
  confirmation that lists what will go, because nobody may know who
  published them.

## 9. Sources

- [R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)
- [R2 pre-signed URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- Pitch MCP tool definitions (`create-presentation-link`,
  `update-presentation-link`, `list-presentation-links`, link analytics),
  reviewed through the Pitch connector.
