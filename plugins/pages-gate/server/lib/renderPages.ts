import env from "@server/env";
import { Attachment, type Collection, type Document } from "@server/models";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import FileStorage from "@server/storage/files";
import { INDEX_PAGE_KEY, documentPageKey } from "./pageKeys";

/** One rendered, plain HTML page, ready to be encrypted and published. */
export interface RenderedPage {
  pageKey: string;
  title: string;
  html: string;
  sourceType: "document" | "collection";
  sourceId: string;
}

/** The pages produced by a render, with human readable warnings. */
export interface RenderResult {
  pages: RenderedPage[];
  warnings: string[];
}

/** What to render and the limits to enforce while doing so. */
export interface RenderInput {
  teamId: string;
  siteTitle: string;
  sources: Array<
    | { type: "document"; document: Document }
    | { type: "collection"; collection: Collection; documents: Document[] }
  >;
  limits?: {
    maxDocuments?: number;
    maxImageBytes?: number;
    maxPageBytes?: number;
  };
}

/** Thrown, before anything is rendered, when too many documents are selected. */
export class TooManyDocumentsError extends Error {
  /** How many publishable documents were selected. */
  public count: number;
  /** The maximum allowed. */
  public limit: number;

  /**
   * @param count how many publishable documents were selected.
   * @param limit the maximum allowed.
   */
  constructor(count: number, limit: number) {
    super(`Too many documents: ${count} selected, the limit is ${limit}`);
    this.name = "TooManyDocumentsError";
    this.count = count;
    this.limit = limit;
  }
}

/** Thrown when a page is still over the size limit with all images removed. */
export class PageTooLargeError extends Error {
  /** Title of the document whose page is too large. */
  public title: string;
  /** Size of the page in bytes. */
  public bytes: number;
  /** The maximum allowed. */
  public limit: number;

  /**
   * @param title title of the document whose page is too large.
   * @param bytes size of the page in bytes.
   * @param limit the maximum allowed.
   */
  constructor(title: string, bytes: number, limit: number) {
    super(`Page "${title}" is ${bytes} bytes, the limit is ${limit}`);
    this.name = "PageTooLargeError";
    this.title = title;
    this.bytes = bytes;
    this.limit = limit;
  }
}

const DEFAULT_MAX_DOCUMENTS = 50;
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_PAGE_BYTES = 15 * 1024 * 1024;

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_ID = /^[0-9a-z]{10}$/i;
// Only used to parse hrefs; nothing is ever requested from this host.
const PARSE_BASE = "http://local.invalid";

interface Candidate {
  document: Document;
  pageKey: string;
}

type LoadedImage = { dataUri: string } | { problem: string };

/**
 * Renders the selected documents and collections to plain HTML pages. Images
 * are inlined as data URIs, non-image attachments are never published, links
 * between the published documents are made relative, and scripts and external
 * stylesheets are removed. Every document and attachment must belong to
 * `input.teamId`. Read permission is the caller's responsibility.
 *
 * @param input the sources, team and limits.
 * @returns the pages and warnings.
 * @throws {TooManyDocumentsError} when more than maxDocuments are publishable.
 * @throws {PageTooLargeError} when a page exceeds maxPageBytes without images.
 */
export async function renderPages(input: RenderInput): Promise<RenderResult> {
  const maxDocuments = input.limits?.maxDocuments ?? DEFAULT_MAX_DOCUMENTS;
  const maxImageBytes = input.limits?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxPageBytes = input.limits?.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES;
  const warnings: string[] = [];

  // Select what is publishable. Nothing is read from storage before the
  // document count has been checked.
  const selected = new Map<string, Document>();
  const groups: Array<{
    title: string;
    sourceType: "document" | "collection";
    sourceId: string;
    documents: Document[];
  }> = [];

  const accept = (document: Document): boolean => {
    if (document.teamId !== input.teamId) {
      warnings.push(`Skipped document ${document.id}: not in this team.`);
      return false;
    }
    const reason = document.deletedAt
      ? "deleted"
      : document.archivedAt
        ? "archived"
        : !document.publishedAt
          ? "a draft"
          : undefined;
    if (reason) {
      warnings.push(`Skipped "${document.title}": it is ${reason}.`);
      return false;
    }
    selected.set(document.id, document);
    return true;
  };

  for (const source of input.sources) {
    if (source.type === "document") {
      groups.push({
        title: source.document.title,
        sourceType: "document",
        sourceId: source.document.id,
        documents: accept(source.document) ? [source.document] : [],
      });
      continue;
    }
    if (source.collection.teamId !== input.teamId) {
      warnings.push(
        `Skipped collection ${source.collection.id}: not in this team.`
      );
      continue;
    }
    groups.push({
      title: source.collection.name,
      sourceType: "collection",
      sourceId: source.collection.id,
      documents: source.documents.filter(accept),
    });
  }

  if (selected.size > maxDocuments) {
    throw new TooManyDocumentsError(selected.size, maxDocuments);
  }
  if (selected.size === 0) {
    return { pages: [], warnings };
  }

  const single =
    input.sources.length === 1 && input.sources[0].type === "document";
  const candidates = new Map<string, Candidate>();
  for (const document of selected.values()) {
    candidates.set(document.id, {
      document,
      pageKey: single ? INDEX_PAGE_KEY : documentPageKey(document.id),
    });
  }

  const { JSDOM } = await import("jsdom");
  const images = new Map<string, Promise<LoadedImage>>();
  const loadImage = (id: string) => {
    let loaded = images.get(id);
    if (!loaded) {
      loaded = readImage(id, input.teamId, maxImageBytes);
      images.set(id, loaded);
    }
    return loaded;
  };

  const pages: RenderedPage[] = [];
  if (!single) {
    pages.push({
      pageKey: INDEX_PAGE_KEY,
      title: input.siteTitle,
      html: renderListing(input.siteTitle, groups, candidates),
      sourceType: groups[0].sourceType,
      sourceId: groups[0].sourceId,
    });
  }

  // Index of every way a document can be addressed from a link.
  const byAddress = new Map<string, Candidate>();
  for (const candidate of candidates.values()) {
    byAddress.set(candidate.document.id.toLowerCase(), candidate);
    byAddress.set(candidate.document.urlId.toLowerCase(), candidate);
  }
  const internalOrigin = safeOrigin(env.URL);

  const published = new Set<string>();
  for (const group of groups) {
    for (const document of group.documents) {
      const candidate = candidates.get(document.id);
      if (!candidate || published.has(document.id)) {
        continue;
      }
      published.add(document.id);

      const raw = await DocumentHelper.toHTML(document, {
        includeTitle: true,
        includeStyles: true,
        includeHead: true,
        centered: false,
        // The injected mermaid script imports from cdn.jsdelivr.net, so it is
        // not self-contained; diagrams stay as code blocks.
        includeMermaid: false,
      });
      const dom = new JSDOM(raw);
      const doc = dom.window.document;
      const label = `"${document.title}"`;

      // Active and external content the export itself introduces.
      if (doc.querySelectorAll("script").length) {
        warnings.push(`Page ${label}: a script was removed.`);
      }
      doc.querySelectorAll("script").forEach((el) => el.remove());
      if (doc.querySelectorAll("link").length) {
        warnings.push(
          `Page ${label}: an external stylesheet was removed, so some formatting such as formulas may look plain.`
        );
      }
      doc.querySelectorAll("link").forEach((el) => el.remove());
      doc.querySelectorAll("style").forEach((el) => {
        el.textContent = (el.textContent ?? "").replace(/@import[^;]*;?/gi, "");
      });
      if (
        doc.querySelector(
          '[data-language="mermaid"], [data-language="mermaidjs"]'
        )
      ) {
        warnings.push(
          `Page ${label}: diagrams are shown as code because rendering them needs an external script.`
        );
      }

      // Images become data URIs, or are removed.
      const inlined: Array<{ img: Element; bytes: number; alt: string }> = [];
      for (const img of Array.from(doc.querySelectorAll("img"))) {
        const id = attachmentId(img.getAttribute("src"));
        if (!id) {
          continue;
        }
        const alt = img.getAttribute("alt") ?? "";
        const loaded = await loadImage(id);
        if ("problem" in loaded) {
          warnings.push(`Page ${label}: image removed, ${loaded.problem}.`);
          replaceWithText(doc, img, alt);
          continue;
        }
        img.setAttribute("src", loaded.dataUri);
        inlined.push({ img, bytes: loaded.dataUri.length, alt });
      }

      // Other attachments are never published.
      for (const widget of Array.from(
        doc.querySelectorAll(".component-attachment")
      )) {
        const link = widget.querySelector("a[href]");
        if (link && attachmentId(link.getAttribute("href"))) {
          const text = widget.querySelector("strong")?.textContent ?? "";
          warnings.push(
            `Page ${label}: attachment "${text}" is not published, only its name is kept.`
          );
          replaceWithText(doc, widget, text);
        }
      }
      for (const el of Array.from(doc.querySelectorAll("[src]"))) {
        if (el.tagName !== "IMG" && attachmentId(el.getAttribute("src"))) {
          warnings.push(`Page ${label}: an embedded attachment was removed.`);
          el.remove();
        }
      }
      // Fail closed: whatever still points at this app or at the storage
      // (canonical attachment URLs, relative paths) must not be published.
      for (const el of Array.from(doc.querySelectorAll("[src]"))) {
        if (!isInternalSrc(el.getAttribute("src"), internalOrigin)) {
          continue;
        }
        warnings.push(
          `Page ${label}: ${el.tagName === "IMG" ? "an image" : "an embedded file"} hosted by this workspace was removed.`
        );
        if (el.tagName === "IMG") {
          replaceWithText(doc, el, el.getAttribute("alt") ?? "");
        } else {
          el.remove();
        }
      }

      // Links.
      let outside = 0;
      for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
        const href = a.getAttribute("href") ?? "";
        if (attachmentId(href)) {
          warnings.push(
            `Page ${label}: an attachment link was replaced with its text.`
          );
          unwrap(a);
          continue;
        }
        if (/^\s*(javascript|vbscript|data):/i.test(href)) {
          warnings.push(`Page ${label}: an unsafe link was removed.`);
          unwrap(a);
          continue;
        }
        const target = internalDocPath(href, internalOrigin);
        if (!target) {
          continue;
        }
        const linked = resolveDocument(target.segment, byAddress);
        if (linked) {
          a.setAttribute("href", linked.pageKey + target.suffix);
        } else {
          outside += 1;
        }
      }
      if (outside) {
        warnings.push(
          `Page ${label}: ${outside} link${outside === 1 ? "" : "s"} to documents outside the published set left unchanged.`
        );
      }

      // Fit the page size, dropping the largest images first.
      let size = Buffer.byteLength(dom.serialize());
      const dropped = inlined.sort((a, b) => b.bytes - a.bytes);
      while (size > maxPageBytes && dropped.length) {
        const next = dropped.shift();
        if (next) {
          replaceWithText(doc, next.img, next.alt);
          size -= next.bytes;
          warnings.push(
            `Page ${label}: an image was dropped, the page was too large.`
          );
        }
      }
      const html = dom.serialize();
      dom.window.close();
      const finalSize = Buffer.byteLength(html);
      if (finalSize > maxPageBytes) {
        throw new PageTooLargeError(document.title, finalSize, maxPageBytes);
      }

      pages.push({
        pageKey: candidate.pageKey,
        title: document.title,
        html,
        sourceType: group.sourceType,
        sourceId: group.sourceId,
      });
    }
  }

  return { pages, warnings };
}

async function readImage(
  id: string,
  teamId: string,
  maxImageBytes: number
): Promise<LoadedImage> {
  // Scoped to the team in the query, another team's row is never loaded.
  const attachment = await Attachment.findOne({ where: { id, teamId } });
  if (!attachment || attachment.teamId !== teamId) {
    return { problem: "the attachment was not found in this team" };
  }
  const contentType = attachment.contentType.split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(contentType)) {
    return { problem: `unsupported content type ${contentType}` };
  }
  if (attachment.size > maxImageBytes) {
    return { problem: "the image is too large" };
  }
  let buffer: Buffer;
  try {
    buffer = await FileStorage.getFileBuffer(attachment.key);
  } catch (_err) {
    return { problem: "the image could not be read" };
  }
  if (buffer.length > maxImageBytes) {
    return { problem: "the image is too large" };
  }
  return {
    dataUri: `data:${contentType};base64,${buffer.toString("base64")}`,
  };
}

function renderListing(
  siteTitle: string,
  groups: Array<{
    title: string;
    sourceType: "document" | "collection";
    documents: Document[];
  }>,
  candidates: Map<string, Candidate>
): string {
  const item = (document: Document) => {
    const key = candidates.get(document.id)?.pageKey ?? "";
    return `<li><a href="${escapeHtml(key)}">${escapeHtml(document.title || "Untitled")}</a></li>`;
  };
  const body = groups
    .map((group) =>
      group.sourceType === "collection"
        ? `<section><h2>${escapeHtml(group.title)}</h2><ul>${group.documents.map(item).join("")}</ul></section>`
        : group.documents.length
          ? `<ul>${group.documents.map(item).join("")}</ul>`
          : ""
    )
    .join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(siteTitle)}</title><style>body{font-family:system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;line-height:1.5}ul{padding-left:1.25rem}a{color:#1d4ed8}</style></head><body><main><h1>${escapeHtml(siteTitle)}</h1>${body}</main></body></html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The attachment id of an attachments.redirect URL, in any form. */
function attachmentId(url: string | null): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url.trim(), PARSE_BASE);
    const id = parsed.searchParams.get("id");
    if (parsed.pathname.endsWith("/api/attachments.redirect") && id) {
      return UUID.test(id) ? id.toLowerCase() : undefined;
    }
  } catch (_err) {
    // Not a URL, so not an attachment link.
  }
  return undefined;
}

/**
 * Whether a src is relative, hosted by this app, or in file storage. Hosts are
 * compared by parsed host and port, independent of scheme, and protocol
 * relative URLs inherit the app's origin.
 */
function isInternalSrc(src: string | null, origin: string | undefined) {
  const value = (src ?? "").trim();
  if (!value || /^data:/i.test(value)) {
    return false;
  }
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(value);
  if (!absolute && !value.startsWith("//")) {
    return true;
  }
  const base = origin ?? PARSE_BASE;
  try {
    const url = new URL(value, base);
    if (origin && hostKey(url) === hostKey(new URL(origin))) {
      return true;
    }
    const storageBase = FileStorage.getUrlForKey("");
    if (!storageBase) {
      return false;
    }
    const storage = new URL(storageBase, base);
    return (
      hostKey(url) === hostKey(storage) &&
      url.pathname.startsWith(storage.pathname)
    );
  } catch (_err) {
    return true;
  }
}

/**
 * Canonical host identity of a URL: the parser's lowercased, punycoded
 * hostname without trailing dots (a fully qualified name is the same server),
 * plus the port, which the parser leaves empty for its scheme's default.
 */
function hostKey(url: URL): string {
  return `${url.hostname.replace(/\.+$/, "")}:${url.port}`;
}

function safeOrigin(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).origin : undefined;
  } catch (_err) {
    return undefined;
  }
}

/** The `/doc/<segment>` target of a link into this Outline, if it is one. */
function internalDocPath(
  href: string,
  origin: string | undefined
): { segment: string; suffix: string } | undefined {
  const trimmed = href.trim();
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  if (absolute && !(origin && trimmed.startsWith(`${origin}/`))) {
    return undefined;
  }
  if (!absolute && !trimmed.startsWith("/")) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed, origin ?? PARSE_BASE);
    const match = /^\/doc\/([^/]+)\/?$/.exec(parsed.pathname);
    if (!match) {
      return undefined;
    }
    return {
      segment: decodeURIComponent(match[1]),
      suffix: parsed.hash,
    };
  } catch (_err) {
    return undefined;
  }
}

function resolveDocument(
  segment: string,
  byAddress: Map<string, Candidate>
): Candidate | undefined {
  const lower = segment.toLowerCase();
  const direct = byAddress.get(lower);
  if (direct) {
    return direct;
  }
  const tail = lower.slice(lower.lastIndexOf("-") + 1);
  return lower.includes("-") && URL_ID.test(tail)
    ? byAddress.get(tail)
    : undefined;
}

function replaceWithText(
  doc: { createTextNode(text: string): Node },
  el: Element,
  text: string
) {
  el.replaceWith(doc.createTextNode(text));
}

function unwrap(el: Element) {
  el.replaceWith(...Array.from(el.childNodes));
}
