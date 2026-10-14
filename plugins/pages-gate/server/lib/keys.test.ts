import {
  RESERVED_SLUGS,
  InvalidPageKeyError,
  InvalidSlugError,
  KeyOutsideSiteError,
  assertKeyWithinSite,
  assertPrefixWithinSite,
  assertValidPageKey,
  assertValidSlug,
  isValidPageKey,
  isValidSlug,
  siteKey,
  sitePrefix,
} from "./keys";

describe("slugs", () => {
  it.each(["acme", "acme-docs", "a1b", "client-2026", "a".repeat(40)])(
    "accepts %j",
    (slug) => {
      expect(isValidSlug(slug)).toBe(true);
      expect(() => assertValidSlug(slug)).not.toThrow();
    }
  );

  it.each([
    "",
    "ab",
    "a".repeat(41),
    "Acme",
    "acme_docs",
    "acme.docs",
    "-acme",
    "acme-",
    "acme--docs",
    "acme docs",
    "acme/docs",
    "../acme",
    "acmé",
    "ａcme", // fullwidth "a"
    "acme\n",
    "\nacme",
    " acme",
    "acme\u0000",
    "acme​", // zero-width space
    "platform-architecture",
    "platform-onboarding",
    "implexus-platform",
    "robots.txt",
    "_headers",
  ])("rejects %j", (slug) => {
    expect(isValidSlug(slug)).toBe(false);
    expect(() => assertValidSlug(slug)).toThrow(InvalidSlugError);
  });

  it.each([undefined, null, 1234, ["acme"], { toString: () => "acme" }])(
    "rejects the non-string %j",
    (value) => {
      const slug = value as unknown as string;
      expect(isValidSlug(slug)).toBe(false);
      expect(() => assertValidSlug(slug)).toThrow(InvalidSlugError);
    }
  );

  it("carries a reason on the error", () => {
    try {
      assertValidSlug("implexus-platform");
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSlugError);
      expect(err).toBeInstanceOf(Error);
      expect((err as InvalidSlugError).reason).toEqual(expect.any(String));
    }
  });

  it("cannot be widened by mutating the reserved list", () => {
    expect(Object.isFrozen(RESERVED_SLUGS)).toBe(true);
    expect(RESERVED_SLUGS).toEqual([
      "platform-architecture",
      "platform-onboarding",
      "implexus-platform",
      "robots.txt",
      "_headers",
    ]);
  });
});

describe("page keys", () => {
  it.each([
    "index.html",
    "guide/setup.html",
    "assets/a1b2.png",
    "a",
    "a_b-c.d/e.f",
    "a".repeat(512),
  ])("accepts %j", (pageKey) => {
    expect(isValidPageKey(pageKey)).toBe(true);
    expect(() => assertValidPageKey(pageKey)).not.toThrow();
  });

  it.each([
    "../x",
    "a/../../b",
    "..",
    ".",
    "./a",
    "a/./b",
    "a/..",
    "...",
    "a//b",
    "/abs",
    "a/",
    "a\\b",
    "..\\x",
    "%2e%2e/x",
    "a/%2e%2e/b",
    "a%2fb",
    ".hidden",
    "a/.env",
    "A.html",
    "a b.html",
    "a\tb",
    "a\u0000b",
    "a\nb",
    "index.html\n",
    "．．/x", // fullwidth full stops
    "․․/x", // one dot leaders
    "a∕b", // division slash
    "café.html",
    "a?b",
    "a#b",
    "a:b",
    "a".repeat(513),
    "",
  ])("rejects %j", (pageKey) => {
    expect(isValidPageKey(pageKey)).toBe(false);
    expect(() => assertValidPageKey(pageKey)).toThrow(InvalidPageKeyError);
  });

  it.each([undefined, null, 42, ["index.html"]])(
    "rejects the non-string %j",
    (value) => {
      const pageKey = value as unknown as string;
      expect(isValidPageKey(pageKey)).toBe(false);
      expect(() => assertValidPageKey(pageKey)).toThrow(InvalidPageKeyError);
    }
  );
});

describe("sitePrefix and siteKey", () => {
  it("builds the prefix with a trailing slash", () => {
    expect(sitePrefix("acme")).toBe("sites/acme/");
  });

  it("builds a site key", () => {
    expect(siteKey("acme", "guide/setup.html")).toBe(
      "sites/acme/guide/setup.html"
    );
  });

  it("refuses an invalid slug", () => {
    expect(() => sitePrefix("../acme")).toThrow(InvalidSlugError);
    expect(() => siteKey("_headers", "index.html")).toThrow(InvalidSlugError);
  });

  it("refuses an invalid page key", () => {
    expect(() => siteKey("acme", "../other/index.html")).toThrow(
      InvalidPageKeyError
    );
    expect(() => siteKey("acme", "")).toThrow(InvalidPageKeyError);
  });
});

describe("assertKeyWithinSite", () => {
  it("passes a key inside the site", () => {
    expect(() =>
      assertKeyWithinSite("foo", "sites/foo/index.html")
    ).not.toThrow();
    expect(() =>
      assertKeyWithinSite("foo", "sites/foo/guide/setup.html")
    ).not.toThrow();
  });

  it.each([
    "sites/foo-bar/index.html", // prefix collision
    "sites/foo",
    "sites/foo/",
    "sites/foo/../bar/index.html",
    "sites/foo/./index.html",
    "sites/foo//index.html",
    "sites/foo/guide/",
    "sites/foo/.env",
    "sites/foo/%2e%2e/bar/index.html",
    "sites/foo/．．/bar/index.html",
    "sites/bar/index.html",
    "sites/FOO/index.html",
    "foo/index.html",
    "index.html",
    "/sites/foo/index.html",
    "./sites/foo/index.html",
    "sites//foo/index.html",
    "xsites/foo/index.html",
    "",
  ])("throws for %j", (key) => {
    expect(() => assertKeyWithinSite("foo", key)).toThrow(KeyOutsideSiteError);
  });

  it("throws for a non-string key", () => {
    expect(() =>
      assertKeyWithinSite("foo", undefined as unknown as string)
    ).toThrow(KeyOutsideSiteError);
  });

  it("refuses an invalid slug before looking at the key", () => {
    expect(() => assertKeyWithinSite("", "sites//index.html")).toThrow(
      InvalidSlugError
    );
    expect(() =>
      assertKeyWithinSite("robots.txt", "sites/robots.txt/index.html")
    ).toThrow(InvalidSlugError);
  });
});

describe("assertPrefixWithinSite", () => {
  it.each(["sites/foo/", "sites/foo/guide/", "sites/foo/guide/assets/"])(
    "passes %j",
    (prefix) => {
      expect(() => assertPrefixWithinSite("foo", prefix)).not.toThrow();
    }
  );

  it.each([
    "sites/",
    "sites/foo",
    "sites/foo-bar/",
    "sites/foo/../",
    "sites/foo/./",
    "sites/foo//",
    "sites/foo/guide",
    "sites/foo/guide//",
    "sites/foo/.git/",
    "sites/foo/%2e%2e/",
    "sites/bar/",
    "",
    "/",
  ])("throws for %j", (prefix) => {
    expect(() => assertPrefixWithinSite("foo", prefix)).toThrow(
      KeyOutsideSiteError
    );
  });

  it("throws for a non-string prefix", () => {
    expect(() =>
      assertPrefixWithinSite("foo", null as unknown as string)
    ).toThrow(KeyOutsideSiteError);
  });

  it("refuses an invalid slug", () => {
    expect(() => assertPrefixWithinSite("", "sites/")).toThrow(
      InvalidSlugError
    );
  });
});
