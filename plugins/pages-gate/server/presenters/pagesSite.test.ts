import type { PagesSite } from "@server/models";
import { PagesSiteKind, PagesSiteStatus } from "@server/models/PagesSite";
import pagesEnv from "../env";
import { presentPagesSite, publishedUrl } from "./pagesSite";

function site(overrides: Partial<PagesSite>) {
  return {
    slug: "demo-1",
    status: PagesSiteStatus.Published,
    kind: PagesSiteKind.Pages,
    ...overrides,
  } as PagesSite;
}

describe("publishedUrl", () => {
  const original = pagesEnv.PAGES_PUBLIC_BASE_URL;
  beforeEach(() => {
    pagesEnv.PAGES_PUBLIC_BASE_URL = "https://pages.example.test/";
  });
  afterEach(() => {
    pagesEnv.PAGES_PUBLIC_BASE_URL = original;
  });

  it("keeps the sites/ address for pages", () => {
    expect(publishedUrl(site({}))).toBe(
      "https://pages.example.test/sites/demo-1/index.html"
    );
  });

  it("uses artifacts/ and names index.html for artifacts", () => {
    expect(publishedUrl(site({ kind: PagesSiteKind.Artifact }))).toBe(
      "https://pages.example.test/artifacts/demo-1/index.html"
    );
  });

  it("is null unless published", () => {
    expect(
      publishedUrl(
        site({ kind: PagesSiteKind.Artifact, status: PagesSiteStatus.Draft })
      )
    ).toBeNull();
  });
});

describe("presentPagesSite", () => {
  it("includes the kind", () => {
    expect(presentPagesSite(site({ kind: PagesSiteKind.Artifact })).kind).toBe(
      PagesSiteKind.Artifact
    );
  });
});
