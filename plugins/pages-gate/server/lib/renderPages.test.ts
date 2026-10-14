import { randomUUID } from "crypto";
import { randomString } from "@shared/random";
import env from "@server/env";
import FileStorage from "@server/storage/files";
import {
  buildAttachment,
  buildCollection,
  buildDocument,
  buildTeam,
  buildUser,
} from "@server/test/factories";
import { isValidPageKey } from "./keys";
import { documentPageKey } from "./pageKeys";
import { TooManyDocumentsError, renderPages } from "./renderPages";

// The first test boots the database and jsdom; under a parallel run it can
// pass the 5 s default.
vi.setConfig({ testTimeout: 60_000 });

// Newer prosemirror-view releases add an empty `<img class="ProseMirror-
// separator" alt="">` to exported paragraphs that end in an image. It has no
// `src`, so it makes no request; what must never survive in a published page
// is an image that has one.
const IMG_WITH_SRC = /<img\b[^>]*\ssrc\s*=/i;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function setup() {
  const team = await buildTeam();
  const user = await buildUser({ teamId: team.id });
  const doc = (overrides: Parameters<typeof buildDocument>[0] = {}) =>
    buildDocument({ teamId: team.id, userId: user.id, ...overrides });
  return { team, user, doc };
}

function spyStorage(buffer = PNG) {
  return vi.spyOn(FileStorage, "getFileBuffer").mockResolvedValue(buffer);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderPages page set", () => {
  it("renders a single document as index.html", async () => {
    const { team, doc } = await setup();
    const document = await doc({ title: "Only one" });
    const result = await renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: [{ type: "document", document }],
    });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({
      pageKey: "index.html",
      title: "Only one",
      sourceType: "document",
      sourceId: document.id,
    });
    expect(result.pages[0].html).toContain("Only one");
    expect(result.warnings).toEqual([]);
  });

  it("renders two documents as a listing plus two pages", async () => {
    const { team, doc } = await setup();
    const a = await doc({ title: "First" });
    const b = await doc({ title: "Second" });
    const { pages } = await renderPages({
      teamId: team.id,
      siteTitle: "My site",
      sources: [
        { type: "document", document: a },
        { type: "document", document: b },
      ],
    });
    expect(pages.map((p) => p.pageKey)).toEqual([
      "index.html",
      documentPageKey(a.id),
      documentPageKey(b.id),
    ]);
    for (const page of pages) {
      expect(isValidPageKey(page.pageKey)).toBe(true);
      // Opaque: no part of a title reaches an address.
      expect(page.pageKey.toLowerCase()).not.toMatch(/first|second|my-site/);
    }
    expect(pages.map((p) => p.title)).toEqual(["My site", "First", "Second"]);
    const listing = pages[0].html;
    expect(listing).toContain("My site");
    expect(listing).toContain(`href="${pages[1].pageKey}"`);
    expect(listing).toContain(`href="${pages[2].pageKey}"`);
    expect(listing).not.toContain("<script");
  });

  it("expands a collection source into its documents", async () => {
    const { team, user, doc } = await setup();
    const collection = await buildCollection({
      teamId: team.id,
      userId: user.id,
      name: "Handbook",
    });
    const a = await doc({ title: "Alpha", collectionId: collection.id });
    const b = await doc({ title: "Beta", collectionId: collection.id });
    const { pages } = await renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: [{ type: "collection", collection, documents: [a, b] }],
    });
    expect(pages).toHaveLength(3);
    expect(pages[0].pageKey).toBe("index.html");
    expect(pages[0].html).toContain("Handbook");
    // Pages of a collection source are attributed to the collection.
    expect(pages.slice(1).map((p) => [p.sourceType, p.sourceId])).toEqual([
      ["collection", collection.id],
      ["collection", collection.id],
    ]);
  });

  it("escapes titles in the listing page", async () => {
    const { team, doc } = await setup();
    const a = await doc({ title: `<script>alert("x")</script>` });
    const b = await doc({ title: "Plain" });
    const { pages } = await renderPages({
      teamId: team.id,
      siteTitle: `Site <b>"q"</b>`,
      sources: [
        { type: "document", document: a },
        { type: "document", document: b },
      ],
    });
    const listing = pages[0].html;
    expect(listing).not.toContain("<script");
    expect(listing).not.toContain("<b>");
    expect(listing).toContain("&lt;script&gt;");
    expect(listing).toContain("&quot;");
  });

  it("skips drafts, archived, deleted and other-team documents with warnings", async () => {
    const { team, doc } = await setup();
    const other = await buildDocument({ title: "Foreign" });
    const ok = await doc({ title: "Fine" });
    const draft = await doc({ title: "A draft", publishedAt: null });
    const archived = await doc({ title: "Old news", archivedAt: new Date() });
    const deleted = await doc({ title: "Gone", deletedAt: new Date() });
    const { pages, warnings } = await renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: [ok, draft, archived, deleted, other].map((document) => ({
        type: "document" as const,
        document,
      })),
    });
    const documentPages = pages.filter((p) => p.pageKey !== "index.html");
    expect(documentPages.map((p) => p.sourceId)).toEqual([ok.id]);
    expect(warnings.filter((w) => w.includes("Skipped"))).toHaveLength(4);
    expect(warnings.join("\n")).toContain("A draft");
    expect(warnings.join("\n")).toContain("Old news");
    expect(warnings.join("\n")).toContain("Gone");
    // Another team's title is never echoed back.
    expect(warnings.join("\n")).not.toContain("Foreign");
    // With one survivor from several sources the listing is still generated.
    expect(pages[0].pageKey).toBe("index.html");
    expect(pages[0].html).not.toContain("A draft");
  });

  it("skips a collection of another team", async () => {
    const { team, doc } = await setup();
    const collection = await buildCollection({ name: "Foreign collection" });
    const foreignDoc = await buildDocument({
      teamId: collection.teamId,
      collectionId: collection.id,
      userId: collection.createdById,
    });
    const ok = await doc({ title: "Mine" });
    const { pages, warnings } = await renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: [
        { type: "document", document: ok },
        { type: "collection", collection, documents: [foreignDoc] },
      ],
    });
    expect(
      pages.filter((p) => p.pageKey !== "index.html").map((p) => p.sourceId)
    ).toEqual([ok.id]);
    expect(pages.map((p) => p.html).join("")).not.toContain(
      "Foreign collection"
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("throws before reading any attachment when over maxDocuments", async () => {
    const { team, user, doc } = await setup();
    const attachment = await buildAttachment({
      teamId: team.id,
      userId: user.id,
    });
    const spy = spyStorage();
    const docs = [
      await doc({ text: `![x](${attachment.redirectUrl})` }),
      await doc(),
      await doc(),
    ];
    const attempt = renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: docs.map((document) => ({ type: "document", document })),
      limits: { maxDocuments: 2 },
    });
    await expect(attempt).rejects.toBeInstanceOf(TooManyDocumentsError);
    await expect(attempt).rejects.toMatchObject({ count: 3, limit: 2 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("renderPages images and attachments", () => {
  it("inlines an image attachment as a data URI", async () => {
    const { team, user, doc } = await setup();
    const attachment = await buildAttachment({
      teamId: team.id,
      userId: user.id,
    });
    const spy = spyStorage();
    const document = await doc({
      text: `![diagram](${attachment.redirectUrl})\n\nSee also ![again](${attachment.redirectUrl}&sign=1)`,
    });
    const { pages, warnings } = await renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: [{ type: "document", document }],
    });
    const html = pages[0].html;
    expect(html).toContain(
      `src="data:image/png;base64,${PNG.toString("base64")}"`
    );
    expect(html).not.toContain("attachments.redirect");
    expect(spy).toHaveBeenCalledWith(attachment.key);
    expect(warnings).toEqual([]);
  });

  it("removes images that are missing, foreign, wrongly typed or oversize", async () => {
    const { team, user, doc } = await setup();
    const foreign = await buildAttachment({});
    const pdfAsImage = await buildAttachment(
      { teamId: team.id, userId: user.id, contentType: "application/pdf" },
      "doc.pdf"
    );
    const huge = await buildAttachment({
      teamId: team.id,
      userId: user.id,
      size: 6 * 1024 * 1024,
    });
    const missingUrl = `/api/attachments.redirect?id=${randomUUID()}`;
    const spy = spyStorage();
    const document = await doc({
      text: [
        `![foreign alt](${foreign.redirectUrl})`,
        `![pdf alt](${pdfAsImage.redirectUrl})`,
        `![huge alt](${huge.redirectUrl})`,
        `![missing alt](${missingUrl})`,
      ].join("\n\n"),
    });
    const { pages, warnings } = await renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: [{ type: "document", document }],
    });
    const html = pages[0].html;
    expect(html).not.toMatch(IMG_WITH_SRC);
    expect(html).not.toContain("attachments.redirect");
    expect(html).not.toContain("data:image/png");
    for (const alt of ["foreign alt", "pdf alt", "huge alt", "missing alt"]) {
      expect(html).toContain(alt);
    }
    expect(warnings).toHaveLength(4);
    expect(spy).not.toHaveBeenCalled();
  });

  it("removes canonical storage URLs, keeping alt text", async () => {
    const { team, doc } = await setup();
    const document = await doc({
      text: "![local alt](/api/files.get?key=uploads/x/y.png)",
    });
    const { pages, warnings } = await renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: [{ type: "document", document }],
    });
    expect(pages[0].html).not.toContain("api/files.get");
    expect(pages[0].html).toContain("local alt");
    expect(warnings).toHaveLength(1);
  });

  it("inlines an absolute redirect URL but removes other app URLs", async () => {
    const { team, user, doc } = await setup();
    const attachment = await buildAttachment({
      teamId: team.id,
      userId: user.id,
    });
    spyStorage();
    const document = await doc({
      text: [
        `![abs alt](${env.URL}${attachment.redirectUrl})`,
        `![app alt](${env.URL}/something-else.png)`,
      ].join("\n\n"),
    });
    const { pages, warnings } = await renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: [{ type: "document", document }],
    });
    const html = pages[0].html;
    expect(html).toContain("data:image/png;base64,");
    expect(html).not.toContain("something-else.png");
    expect(html).toContain("app alt");
    expect(warnings).toHaveLength(1);
  });

  it("removes bucket style storage URLs", async () => {
    const { team, doc } = await setup();
    vi.spyOn(FileStorage, "getUrlForKey").mockImplementation(
      (key: string) => `https://bucket.storage.test/${key}`
    );
    const document = await doc({
      text: "![bucket alt](https://bucket.storage.test/uploads/a/b.png)",
    });
    const { pages, warnings } = await renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: [{ type: "document", document }],
    });
    expect(pages[0].html).not.toContain("bucket.storage.test");
    expect(pages[0].html).toContain("bucket alt");
    expect(warnings).toHaveLength(1);
  });

  describe("host matching", () => {
    const originalUrl = env.URL;
    beforeEach(() => {
      env.URL = "https://app-host.com";
    });
    afterEach(() => {
      env.URL = originalUrl;
    });

    const render = async (src: string) => {
      const { team, doc } = await setup();
      const document = await doc({ text: `![pic alt](${src})` });
      return renderPages({
        teamId: team.id,
        siteTitle: "Site",
        sources: [{ type: "document", document }],
      });
    };

    it.each([
      "//app-host.com/x.png",
      "http://app-host.com/x.png",
      "https://APP-HOST.com/x.png",
      "https://app-host.com:443/x.png",
      "https://app-host.com./x.png",
      "//app-host.com./x.png",
      "https://app-host.com../x.png",
    ])("removes %s", async (src) => {
      const { pages, warnings } = await render(src);
      expect(pages[0].html).not.toMatch(IMG_WITH_SRC);
      expect(pages[0].html).toContain("pic alt");
      expect(warnings).toHaveLength(1);
    });

    it.each([
      "//cdn.evil.com/x.png",
      "https://app-host.com.evil.com/x.png",
      "https://app-host.com.evil.com./x.png",
      "https://app-host.com@evil.com/x.png",
      "https://app-host.com:8443/x.png",
      "https://cdn.evil.com/x.png?u=https://app-host.com/x.png",
    ])("keeps %s", async (src) => {
      const { pages, warnings } = await render(src);
      expect(pages[0].html).toMatch(IMG_WITH_SRC);
      expect(warnings).toEqual([]);
    });

    it("matches storage by host and path, not by raw prefix", async () => {
      vi.spyOn(FileStorage, "getUrlForKey").mockImplementation(
        (key: string) => `https://bucket.s3.amazonaws.com/${key}`
      );
      const removed = await render("//BUCKET.s3.amazonaws.com/uploads/a.png");
      expect(removed.pages[0].html).not.toMatch(IMG_WITH_SRC);
      const kept = await render(
        "https://bucket.s3.amazonaws.com.evil.com/x.png"
      );
      expect(kept.pages[0].html).toMatch(IMG_WITH_SRC);
      const dotted = await render(
        "https://bucket.s3.amazonaws.com./uploads/a.png"
      );
      expect(dotted.pages[0].html).not.toMatch(IMG_WITH_SRC);
    });
  });

  it("leaves unrelated external images alone", async () => {
    const { team, doc } = await setup();
    const document = await doc({
      text: "![ext](https://example.com/pic.png)",
    });
    const { pages, warnings } = await renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: [{ type: "document", document }],
    });
    expect(pages[0].html).toContain('src="https://example.com/pic.png"');
    expect(warnings).toEqual([]);
  });

  it("replaces a non-image attachment link with plain text and never reads it", async () => {
    const { team, user, doc } = await setup();
    const pdf = await buildAttachment(
      { teamId: team.id, userId: user.id, contentType: "application/pdf" },
      "report.pdf"
    );
    const spy = spyStorage();
    const document = await doc({
      text: `Read the [annual report](${pdf.redirectUrl}) today`,
    });
    const { pages, warnings } = await renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: [{ type: "document", document }],
    });
    expect(pages[0].html).not.toContain("attachments.redirect");
    expect(pages[0].html).toContain("annual");
    expect(warnings.length).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("drops the largest images until the page fits maxPageBytes", async () => {
    const { team, user, doc } = await setup();
    const small = await buildAttachment({ teamId: team.id, userId: user.id });
    const spy = vi
      .spyOn(FileStorage, "getFileBuffer")
      .mockResolvedValue(Buffer.alloc(200_000, 1));
    const document = await doc({
      text: `![one](${small.redirectUrl})`,
    });
    const baseline = await renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: [{ type: "document", document }],
      limits: { maxImageBytes: 1_000_000 },
    });
    const withImage = Buffer.byteLength(baseline.pages[0].html);
    spy.mockClear();
    const limited = await renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: [{ type: "document", document }],
      limits: { maxImageBytes: 1_000_000, maxPageBytes: withImage - 100_000 },
    });
    expect(limited.pages[0].html).not.toContain("data:image/png");
    expect(limited.warnings.join("\n")).toMatch(/dropped|too large/i);
    expect(Buffer.byteLength(limited.pages[0].html)).toBeLessThanOrEqual(
      withImage - 100_000
    );
  });
});

describe("renderPages links", () => {
  it("rewrites links between published documents to page keys", async () => {
    const { team, doc } = await setup();
    const target = await doc({ title: "Target page" });
    const source = await doc({
      title: "Source page",
      text: `Go to [target](${target.path}) or [again](/doc/${target.urlId}#part)`,
    });
    const { pages } = await renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: [
        { type: "document", document: source },
        { type: "document", document: target },
      ],
    });
    const targetKey = documentPageKey(target.id);
    const html = pages[1].html;
    expect(html).toContain(`href="${targetKey}"`);
    expect(html).toContain(`href="${targetKey}#part"`);
    expect(html).not.toContain(`/doc/`);
  });

  it("links to the index page when the target is the single document", async () => {
    const { team, doc } = await setup();
    const urlId = randomString(10);
    const self = await doc({
      title: "Self",
      urlId,
      text: `[me](/doc/self-${urlId})`,
    });
    const { pages } = await renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: [{ type: "document", document: self }],
    });
    expect(pages[0].html).toContain(`href="index.html"`);
  });

  it("leaves links to unpublished documents unchanged and warns once", async () => {
    const { team, doc } = await setup();
    const outside = await doc({ title: "Outside" });
    const other = await doc({ title: "Also outside" });
    const source = await doc({
      title: "Source",
      text: `[a](${outside.path}) and [b](${other.path})`,
    });
    const { pages, warnings } = await renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: [{ type: "document", document: source }],
    });
    expect(pages[0].html).toContain(`href="${outside.path}"`);
    expect(pages[0].html).toContain(`href="${other.path}"`);
    expect(warnings.filter((w) => w.includes("outside"))).toHaveLength(1);
  });

  it("does not make a javascript: link executable", async () => {
    const { team, doc } = await setup();
    const document = await doc({
      title: "Evil",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "click",
                marks: [
                  { type: "link", attrs: { href: "javascript:alert(1)" } },
                ],
              },
            ],
          },
        ],
      },
    });
    const { pages } = await renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: [{ type: "document", document }],
    });
    expect(pages[0].html).not.toContain(`href="javascript:`);
    expect(pages[0].html).toContain("click");
  });
});

describe("renderPages output hygiene", () => {
  it("contains no script, stylesheet link or external resource of its own", async () => {
    const { team, doc } = await setup();
    const document = await doc({
      title: "Rich",
      text: [
        "```mermaid\ngraph TD; A-->B\n```",
        "$$x^2$$",
        "Inline $y$ math",
        "[external](https://example.com/page)",
      ].join("\n\n"),
    });
    const { pages, warnings } = await renderPages({
      teamId: team.id,
      siteTitle: "Site",
      sources: [{ type: "document", document }],
    });
    const html = pages[0].html;
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link[^>]*stylesheet/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toContain("cdn.jsdelivr.net");
    expect(html).not.toMatch(/url\(\s*['"]?(https?:)?\/\//i);
    // User authored links are left alone.
    expect(html).toContain("https://example.com/page");
    // Mermaid is left as a code block and flagged.
    expect(html).toContain("graph TD");
    expect(warnings.some((w) => /diagram/i.test(w))).toBe(true);
  });

  it("is deterministic", async () => {
    const { team, user, doc } = await setup();
    const attachment = await buildAttachment({
      teamId: team.id,
      userId: user.id,
    });
    spyStorage();
    const a = await doc({
      title: "A",
      text: `![i](${attachment.redirectUrl}) and **bold**`,
    });
    const b = await doc({ title: "B", text: "[a](" + a.path + ")" });
    const input = {
      teamId: team.id,
      siteTitle: "Site",
      sources: [
        { type: "document" as const, document: a },
        { type: "document" as const, document: b },
      ],
    };
    const first = await renderPages(input);
    const second = await renderPages(input);
    expect(second).toEqual(first);
  });
});
