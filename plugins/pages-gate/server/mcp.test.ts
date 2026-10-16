import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import env from "@server/env";
import { Document, PagesSite } from "@server/models";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { PagesSiteKind, PagesSiteStatus } from "@server/models/PagesSite";
import FileStorage from "@server/storage/files";
import {
  buildAdmin,
  buildAttachment,
  buildDocument,
  buildOAuthAuthentication,
  buildUser,
} from "@server/test/factories";
import {
  buildOAuthUser,
  callMcpTool,
  mcpHeaders,
  mcpRequest,
  parseMcpResponse,
} from "@server/test/McpHelper";
import { getTestServer } from "@server/test/support";
import pagesEnv from "./env";
import type { ObjectStore } from "./lib/objectStore";
import { MAX_HTML_LENGTH } from "./mcp";
import { buildPagesSite } from "./test/factories";
import { type MemoryStore, createMemoryStore } from "./test/memoryStore";

// Registered at load, before the app is built; the plugin index registers
// nothing while PAGES_* is unset, so the hook is added here with a test store.
const holder = await vi.hoisted(async () => {
  const { PluginManager, Hook } = await import("@server/utils/PluginManager");
  const { pagesMcpTools } = await import("./mcp");
  const state: { store?: ObjectStore } = {};
  PluginManager.add({
    type: Hook.MCPTools,
    value: (server, scopes) =>
      pagesMcpTools(server, scopes, () => {
        if (!state.store) {
          throw new Error("test store not set");
        }
        return state.store;
      }),
  });
  return state;
});

const server = getTestServer();
vi.setConfig({ testTimeout: 60_000 });

const BASE = "https://pages.example.test";
const TOOL = "publish_artifact";

let store: MemoryStore;
const originalBase = pagesEnv.PAGES_PUBLIC_BASE_URL;
const originalProcessBase = process.env.PAGES_PUBLIC_BASE_URL;

beforeEach(() => {
  store = createMemoryStore();
  holder.store = store;
  // pagesEnv builds the published URL; process.env feeds the markdown embed rule.
  pagesEnv.PAGES_PUBLIC_BASE_URL = BASE;
  process.env.PAGES_PUBLIC_BASE_URL = BASE;
});

afterEach(() => {
  pagesEnv.PAGES_PUBLIC_BASE_URL = originalBase;
  if (originalProcessBase === undefined) {
    delete process.env.PAGES_PUBLIC_BASE_URL;
  } else {
    process.env.PAGES_PUBLIC_BASE_URL = originalProcessBase;
  }
  vi.restoreAllMocks();
});

/** Slugs are globally unique and the test database is not reset. */
function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomBytes(5).toString("hex")}`;
}

interface PublishResult {
  publishedUrl: string | null;
  slug: string;
  siteId: string;
  fileCount: number;
  version: number;
  embedAdded: boolean;
  note: string;
}

type ToolResponse = Awaited<ReturnType<typeof callMcpTool>>;

function ok(res: ToolResponse): PublishResult {
  expect(res?.error).toBeUndefined();
  expect(res?.result?.isError).toBeFalsy();
  return JSON.parse(res?.result?.content?.[0]?.text ?? "{}");
}

/** The error text of a refused call, whether refused by the tool or by input validation. */
function refused(res: ToolResponse): string {
  if (res?.error) {
    return JSON.stringify(res.error);
  }
  expect(res?.result?.isError).toBe(true);
  return res?.result?.content?.[0]?.text ?? "";
}

interface Node {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
}

function embeds(node: Node | null | undefined): Node[] {
  if (!node) {
    return [];
  }
  const own = node.type === "embed" ? [node] : [];
  return own.concat(...(node.content ?? []).map(embeds));
}

async function documentEmbeds(id: string): Promise<Node[]> {
  const document = await Document.findByPk(id, { rejectOnEmpty: true });
  return embeds(document.content as Node);
}

async function htmlAttachment(
  owner: { teamId: string; userId: string },
  documentId: string | null,
  body = "<h1>from attachment</h1>"
) {
  const bytes = Buffer.from(body);
  // The model derives `name` from the key, which the factory builds from its second argument.
  const attachment = await buildAttachment(
    { ...owner, documentId, size: bytes.length },
    "x.html"
  );
  // The factory replaces a null documentId with a new document; MCP uploads have none.
  if (documentId === null) {
    await attachment.update({ documentId: null });
  }
  expect(attachment.documentId).toBe(documentId);
  vi.spyOn(FileStorage, "getFileStream").mockImplementation(async () =>
    Readable.from([bytes])
  );
  return attachment;
}

describe("publish_artifact", () => {
  it("publishes html for an admin with the write scope", async () => {
    const { user, accessToken } = await buildOAuthUser({ role: "admin" });
    const slug = uniqueSlug("mcp");
    const out = ok(
      await callMcpTool(server, accessToken, TOOL, {
        html: "<h1>hi</h1>",
        slug,
      })
    );
    expect(out.publishedUrl).toBe(`${BASE}/artifacts/${slug}/index.html`);
    expect(out.slug).toBe(slug);
    expect(out.fileCount).toBe(1);
    expect(out.embedAdded).toBe(false);
    expect(out.note).toContain("same slug");
    expect(store.keys()).toEqual([`artifacts/${slug}/index.html`]);
    expect(store.text(`artifacts/${slug}/index.html`)).toBe("<h1>hi</h1>");
    const site = await PagesSite.findByPk(out.siteId, { rejectOnEmpty: true });
    expect(site.kind).toBe(PagesSiteKind.Artifact);
    expect(site.status).toBe(PagesSiteStatus.Published);
    expect(site.teamId).toBe(user.teamId);
    expect(out.version).toBe(site.currentVersion);
  });

  it("embeds the published page in a document the admin can edit", async () => {
    const { user, accessToken } = await buildOAuthUser({ role: "admin" });
    const document = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
    });
    const out = ok(
      await callMcpTool(server, accessToken, TOOL, {
        html: "<p>embed me</p>",
        slug: uniqueSlug("mcp-embed"),
        documentId: document.id,
      })
    );
    expect(out.embedAdded).toBe(true);
    const found = await documentEmbeds(document.id);
    expect(found.map((node) => node.attrs?.href)).toEqual([out.publishedUrl]);
  });

  it("does not stack a second embed when republishing to the same document", async () => {
    const { user, accessToken } = await buildOAuthUser({ role: "admin" });
    const document = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
    });
    const slug = uniqueSlug("mcp-twice");
    const first = ok(
      await callMcpTool(server, accessToken, TOOL, {
        html: "<p>one</p>",
        slug,
        documentId: document.id,
      })
    );
    const second = ok(
      await callMcpTool(server, accessToken, TOOL, {
        html: "<p>two</p>",
        slug,
        documentId: document.id,
      })
    );
    expect(first.embedAdded).toBe(true);
    expect(second.embedAdded).toBe(true);
    expect(second.note).toContain("already embeds this page");
    const found = await documentEmbeds(document.id);
    expect(found.map((node) => node.attrs?.href)).toEqual([
      second.publishedUrl,
    ]);
  });

  it("does not stack an embed on a document whose content is null and whose text has the embed", async () => {
    const { user, accessToken } = await buildOAuthUser({ role: "admin" });
    const slug = uniqueSlug("mcp-legacy");
    const url = `${BASE}/artifacts/${slug}/index.html`;
    const document = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
    });
    // An older document: the body lives only in markdown text.
    await Document.update(
      { content: null, state: null, text: `Intro\n\n[${url}](${url})\n` },
      { where: { id: document.id }, hooks: false }
    );
    const legacy = await Document.findByPk(document.id, {
      rejectOnEmpty: true,
    });
    expect(legacy.content).toBeNull();
    const out = ok(
      await callMcpTool(server, accessToken, TOOL, {
        html: "<p>x</p>",
        slug,
        documentId: document.id,
      })
    );
    expect(out.publishedUrl).toBe(url);
    expect(out.embedAdded).toBe(true);
    expect(out.note).toContain("already embeds this page");
    const reloaded = await Document.findByPk(document.id, {
      rejectOnEmpty: true,
    });
    const tree = DocumentHelper.toProsemirror(reloaded).toJSON() as Node;
    expect(embeds(tree).map((node) => node.attrs?.href)).toEqual([url]);
  });

  it("adds no embed and says why when the public Pages URL is not configured", async () => {
    pagesEnv.PAGES_PUBLIC_BASE_URL = undefined;
    const { user, accessToken } = await buildOAuthUser({ role: "admin" });
    const document = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
    });
    const out = ok(
      await callMcpTool(server, accessToken, TOOL, {
        html: "<p>x</p>",
        slug: uniqueSlug("mcp-nourl"),
        documentId: document.id,
      })
    );
    expect(out.publishedUrl).toBeNull();
    expect(out.embedAdded).toBe(false);
    expect(out.note).toContain(
      "No embed was added: the public Pages URL is not configured."
    );
    expect(await documentEmbeds(document.id)).toEqual([]);
  });

  it("keeps the embed when update_document replaces the document with its markdown", async () => {
    const { user, accessToken } = await buildOAuthUser({ role: "admin" });
    const document = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
    });
    const out = ok(
      await callMcpTool(server, accessToken, TOOL, {
        html: "<p>round trip</p>",
        slug: uniqueSlug("mcp-rt"),
        documentId: document.id,
      })
    );
    const markdown = await DocumentHelper.toMarkdown(
      await Document.findByPk(document.id, { rejectOnEmpty: true }),
      { includeTitle: false }
    );
    expect(markdown).toContain(`[${out.publishedUrl}](${out.publishedUrl})`);
    const update = await callMcpTool(server, accessToken, "update_document", {
      id: document.id,
      // An unchanged document is reported as an error, so add one line.
      text: `${markdown}\n\nEdited.`,
      editMode: "replace",
    });
    expect(update?.result?.isError).toBeFalsy();
    const found = await documentEmbeds(document.id);
    expect(found.map((node) => node.attrs?.href)).toEqual([out.publishedUrl]);
  });

  it("refuses a non-admin with the same message for a free and a taken slug", async () => {
    const { user, accessToken } = await buildOAuthUser();
    const taken = await buildPagesSite({
      teamId: user.teamId,
      kind: PagesSiteKind.Artifact,
      slug: uniqueSlug("taken"),
      prefix: "artifacts/x/",
      status: PagesSiteStatus.Published,
      gateType: "none",
    });
    const free = uniqueSlug("free");
    const freeMessage = refused(
      await callMcpTool(server, accessToken, TOOL, { html: "x", slug: free })
    );
    const takenMessage = refused(
      await callMcpTool(server, accessToken, TOOL, {
        html: "x",
        slug: taken.slug,
      })
    );
    // Refused before any document or attachment lookup, so unknown ids change nothing.
    const lookupMessage = refused(
      await callMcpTool(server, accessToken, TOOL, {
        attachmentId: "9b6a2d5e-0a3c-4f61-8d8b-6c1f0e1b2a33",
        documentId: "4c1d7f0e-2b3a-4e5f-9a6b-7c8d9e0f1a2b",
        slug: free,
      })
    );
    expect(freeMessage).not.toBe("");
    expect(takenMessage).toBe(freeMessage);
    expect(lookupMessage).toBe(freeMessage);
    expect(store.calls).toEqual([]);
    expect(await PagesSite.count({ where: { slug: free } })).toBe(0);
    const reloaded = await PagesSite.findByPk(taken.id, {
      rejectOnEmpty: true,
    });
    expect(reloaded.currentVersion).toBe(taken.currentVersion);
  });

  it("is not listed for a read-only token and is listed for a write token", async () => {
    const admin = await buildAdmin();
    const list = async (scope: string[]) => {
      const auth = await buildOAuthAuthentication({ user: admin, scope });
      const { body } = mcpRequest("tools/list");
      const res = await server.post("/mcp/", {
        headers: mcpHeaders(auth.accessToken!),
        body,
      });
      const parsed = (await parseMcpResponse(res)) as {
        result: { tools: { name: string }[] };
      };
      return parsed.result.tools.map((tool) => tool.name);
    };
    expect(await list(["read"])).not.toContain(TOOL);
    expect(await list(["read", "create"])).not.toContain(TOOL);
    expect(await list(["write"])).toContain(TOOL);
  });

  it.each([
    [
      "neither html nor attachmentId",
      {},
      /exactly one of html or attachmentId/,
    ],
    [
      "both html and attachmentId",
      { html: "x", attachmentId: "9b6a2d5e-0a3c-4f61-8d8b-6c1f0e1b2a33" },
      /exactly one of html or attachmentId/,
    ],
    [
      "html over the inline cap",
      { html: "a".repeat(MAX_HTML_LENGTH + 1) },
      new RegExp(`${MAX_HTML_LENGTH}|too.?big`, "i"),
    ],
    ["empty html", { html: "" }, /too.?small|at least 1/i],
  ])("refuses %s and writes nothing", async (_label, args, expected) => {
    const { accessToken } = await buildOAuthUser({ role: "admin" });
    const slug = uniqueSlug("bad");
    const message = refused(
      await callMcpTool(server, accessToken, TOOL, { ...args, slug })
    );
    expect(message).toMatch(expected);
    expect(message).not.toMatch(/authoriz/i);
    expect(store.calls).toEqual([]);
    expect(await PagesSite.count({ where: { slug } })).toBe(0);
  });

  it("publishes the caller's own document-less attachment", async () => {
    const { user, accessToken } = await buildOAuthUser({ role: "admin" });
    const attachment = await htmlAttachment(
      { teamId: user.teamId, userId: user.id },
      null
    );
    const slug = uniqueSlug("mcp-att");
    const out = ok(
      await callMcpTool(server, accessToken, TOOL, {
        attachmentId: attachment.id,
        slug,
      })
    );
    expect(out.publishedUrl).toBe(`${BASE}/artifacts/${slug}/index.html`);
    expect(store.text(`artifacts/${slug}/index.html`)).toBe(
      "<h1>from attachment</h1>"
    );
  });

  describe("refuses attachments the caller may not use", () => {
    it.each([
      "another user's document-less attachment",
      "another team's attachment",
      "an attachment of a document the caller cannot update",
      "an attachment of an archived document in the caller's team",
    ])("%s, writing nothing", async (label) => {
      const { user, accessToken } = await buildOAuthUser({ role: "admin" });
      let owner = { teamId: user.teamId, userId: user.id };
      let documentId: string | null = null;
      if (label.startsWith("another user")) {
        owner = {
          teamId: user.teamId,
          userId: (await buildUser({ teamId: user.teamId })).id,
        };
      } else if (label.startsWith("another team")) {
        const stranger = await buildAdmin();
        owner = { teamId: stranger.teamId, userId: stranger.id };
      } else if (label.includes("archived")) {
        documentId = (
          await buildDocument({
            teamId: user.teamId,
            userId: user.id,
            archivedAt: new Date(),
          })
        ).id;
      } else {
        const stranger = await buildAdmin();
        documentId = (
          await buildDocument({
            teamId: stranger.teamId,
            userId: stranger.id,
          })
        ).id;
        // Owned by the caller and in the caller's team, but on a document they cannot edit.
        owner = { teamId: user.teamId, userId: user.id };
      }
      const attachment = await htmlAttachment(owner, documentId);
      const read = vi.mocked(FileStorage.getFileStream);
      const slug = uniqueSlug("mcp-deny");
      const message = refused(
        await callMcpTool(server, accessToken, TOOL, {
          attachmentId: attachment.id,
          slug,
        })
      );
      expect(message).toMatch(/not found/i);
      expect(read).not.toHaveBeenCalled();
      expect(store.calls).toEqual([]);
      expect(await PagesSite.count({ where: { slug } })).toBe(0);
    });
  });

  it("refuses the 11th call within a minute for one user", async () => {
    // .env.test disables the limiters; turned on for this test only.
    const originalEnabled = env.RATE_LIMITER_ENABLED;
    env.RATE_LIMITER_ENABLED = true;
    try {
      const { accessToken } = await buildOAuthUser({ role: "admin" });
      const slug = uniqueSlug("mcp-rate");
      for (let i = 0; i < 10; i++) {
        ok(
          await callMcpTool(server, accessToken, TOOL, {
            html: `<p>${i}</p>`,
            slug,
          })
        );
      }
      const message = refused(
        await callMcpTool(server, accessToken, TOOL, {
          html: "<p>11</p>",
          slug,
        })
      );
      expect(message).toMatch(/rate limit/i);
      expect(store.text(`artifacts/${slug}/index.html`)).toBe("<p>9</p>");
    } finally {
      env.RATE_LIMITER_ENABLED = originalEnabled;
    }
  });

  it("republishes the same slug in place with a higher version", async () => {
    const { accessToken } = await buildOAuthUser({ role: "admin" });
    const slug = uniqueSlug("mcp-re");
    const first = ok(
      await callMcpTool(server, accessToken, TOOL, { html: "one", slug })
    );
    const second = ok(
      await callMcpTool(server, accessToken, TOOL, { html: "two", slug })
    );
    expect(second.publishedUrl).toBe(first.publishedUrl);
    expect(second.siteId).toBe(first.siteId);
    expect(second.version).toBeGreaterThan(first.version);
    expect(store.text(`artifacts/${slug}/index.html`)).toBe("two");
  });

  it.each([
    "another team's document",
    "an archived document in the caller's team",
  ])(
    "refuses a documentId the caller cannot update (%s) before writing anything",
    async (label) => {
      const { user, accessToken } = await buildOAuthUser({ role: "admin" });
      const owner = label.startsWith("another team")
        ? await buildAdmin()
        : user;
      // Archived documents are not active, so "update" is denied even to an admin.
      const document = await buildDocument({
        teamId: owner.teamId,
        userId: owner.id,
        ...(label.startsWith("an archived") && { archivedAt: new Date() }),
      });
      const slug = uniqueSlug("mcp-nodoc");
      refused(
        await callMcpTool(server, accessToken, TOOL, {
          html: "x",
          slug,
          documentId: document.id,
        })
      );
      expect(store.calls).toEqual([]);
      expect(await PagesSite.count({ where: { slug } })).toBe(0);
      expect(await documentEmbeds(document.id)).toEqual([]);
    }
  );

  it("still returns the public URL when the embed cannot be added after publishing", async () => {
    const { user, accessToken } = await buildOAuthUser({ role: "admin" });
    const document = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
    });
    vi.spyOn(Document.prototype, "saveWithCtx").mockRejectedValueOnce(
      new Error("database is unavailable")
    );
    const slug = uniqueSlug("mcp-embedfail");
    const out = ok(
      await callMcpTool(server, accessToken, TOOL, {
        html: "<p>x</p>",
        slug,
        documentId: document.id,
      })
    );
    expect(out.publishedUrl).toBe(`${BASE}/artifacts/${slug}/index.html`);
    expect(out.embedAdded).toBe(false);
    expect(out.note).toMatch(/published/i);
    expect(out.note).toMatch(/embed/i);
    expect(out.note).not.toContain("    at ");
    expect(store.keys()).toEqual([`artifacts/${slug}/index.html`]);
    expect(await documentEmbeds(document.id)).toEqual([]);
  });
});
