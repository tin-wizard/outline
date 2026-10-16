import { parser, serializer } from "@server/editor";

const BASE = "https://pages.example.test";
const URL1 = `${BASE}/artifacts/abc123/index.html`;

describe("pagesEmbeds", () => {
  const original = process.env.PAGES_PUBLIC_BASE_URL;

  beforeEach(() => {
    process.env.PAGES_PUBLIC_BASE_URL = BASE;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.PAGES_PUBLIC_BASE_URL;
    } else {
      process.env.PAGES_PUBLIC_BASE_URL = original;
    }
  });

  it("turns a link-only paragraph for the artifacts host into an embed", () => {
    const doc = parser.parse(`[${URL1}](${URL1})\n`);
    expect(doc?.firstChild?.type.name).toBe("embed");
    expect(doc?.firstChild?.attrs.href).toBe(URL1);
  });

  it("keeps the embed through a serialize/parse round trip (the replace case)", () => {
    const first = parser.parse(`[${URL1}](${URL1})\n`);
    const md = serializer.serialize(first!);
    expect(parser.parse(md)?.firstChild?.type.name).toBe("embed");
  });

  it("leaves a link to another host as a link", () => {
    const other = "https://example.com/artifacts/abc/index.html";
    expect(parser.parse(`[${other}](${other})\n`)?.firstChild?.type.name).toBe(
      "paragraph"
    );
  });

  it("leaves a link with different text as a link", () => {
    expect(parser.parse(`[open it](${URL1})\n`)?.firstChild?.type.name).toBe(
      "paragraph"
    );
  });

  it("leaves a link that is part of a longer paragraph as a link", () => {
    expect(
      parser.parse(`See [${URL1}](${URL1}) now\n`)?.firstChild?.type.name
    ).toBe("paragraph");
  });

  it("leaves a link to the host root or to /sites/ as a link", () => {
    for (const u of [`${BASE}/`, `${BASE}/sites/x/index.html`]) {
      expect(parser.parse(`[${u}](${u})\n`)?.firstChild?.type.name).toBe(
        "paragraph"
      );
    }
  });

  it("leaves a link-only item of a tight list as a link in the list", () => {
    const doc = parser.parse(`- [${URL1}](${URL1})\n`);
    const list = doc?.firstChild;
    expect(doc?.childCount).toBe(1);
    expect(list?.type.name).toBe("bullet_list");
    const item = list?.firstChild;
    expect(item?.childCount).toBe(1);
    const paragraph = item?.firstChild;
    expect(paragraph?.type.name).toBe("paragraph");
    expect(paragraph?.textContent).toBe(URL1);
    expect(paragraph?.firstChild?.marks.map((mark) => mark.type.name)).toEqual([
      "link",
    ]);
    const types: string[] = [];
    doc?.descendants((node) => {
      types.push(node.type.name);
    });
    expect(types).not.toContain("embed");
  });

  it("does nothing when PAGES_PUBLIC_BASE_URL is unset", () => {
    delete process.env.PAGES_PUBLIC_BASE_URL;
    expect(parser.parse(`[${URL1}](${URL1})\n`)?.firstChild?.type.name).toBe(
      "paragraph"
    );
  });

  it("handles a base URL configured with a trailing slash", () => {
    process.env.PAGES_PUBLIC_BASE_URL = `${BASE}/`;
    expect(parser.parse(`[${URL1}](${URL1})\n`)?.firstChild?.type.name).toBe(
      "embed"
    );
  });

  it.each([
    ["dot segments", `${BASE}/artifacts/../sites/x`],
    ["encoded dot segments", `${BASE}/artifacts/%2e%2e/sites/x`],
    ["a lookalike host", "https://pages.example.test.evil.com/artifacts/x"],
    ["userinfo", "https://user:pw@pages.example.test/artifacts/x"],
  ])("leaves a link with %s as a link", (_name, u) => {
    expect(parser.parse(`[${u}](${u})\n`)?.firstChild?.type.name).toBe(
      "paragraph"
    );
  });

  it("turns every matching paragraph into an embed", () => {
    const doc = parser.parse(`[${URL1}](${URL1})\n\n[${URL1}](${URL1})\n`);
    expect(doc?.childCount).toBe(2);
    expect(doc?.child(0).type.name).toBe("embed");
    expect(doc?.child(1).type.name).toBe("embed");
  });

  it("supports a base URL with a path prefix", () => {
    process.env.PAGES_PUBLIC_BASE_URL = `${BASE}/pages`;
    const inside = `${BASE}/pages/artifacts/abc/index.html`;
    expect(
      parser.parse(`[${inside}](${inside})\n`)?.firstChild?.type.name
    ).toBe("embed");
    expect(parser.parse(`[${URL1}](${URL1})\n`)?.firstChild?.type.name).toBe(
      "paragraph"
    );
  });

  it("does nothing and does not throw for an invalid base URL", () => {
    process.env.PAGES_PUBLIC_BASE_URL = "not a url";
    expect(parser.parse(`[${URL1}](${URL1})\n`)?.firstChild?.type.name).toBe(
      "paragraph"
    );
  });
});
