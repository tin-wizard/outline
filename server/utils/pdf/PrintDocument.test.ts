import { buildPrintDocument, escapeHtml, splitHtml } from "./PrintDocument";

describe("splitHtml", () => {
  it("separates styles from the body", () => {
    const { styles, body } = splitHtml(
      `<!DOCTYPE html><html><head><style>p{color:red}</style></head><body><p>Hello</p><script>alert(1)</script></body></html>`
    );

    expect(styles).toBe("<style>p{color:red}</style>");
    expect(body).toBe("<p>Hello</p>");
  });
});

describe("escapeHtml", () => {
  it("escapes markup", () => {
    expect(escapeHtml(`<b class="x">&</b>`)).toBe(
      "&lt;b class=&quot;x&quot;&gt;&amp;&lt;/b&gt;"
    );
  });
});

describe("buildPrintDocument", () => {
  it("renders a section per chapter with escaped titles", () => {
    const html = buildPrintDocument(
      "<style>a{}</style>",
      [
        { title: "One <script>", body: "<p>First</p>" },
        { title: "Two", body: "<p>Second</p>" },
      ],
      "Book"
    );

    expect(html).toContain("<title>Book</title>");
    expect(html).toContain("<style>a{}</style>");
    expect(html).toContain("One &lt;script&gt;");
    expect(html.match(/class="print-chapter"/g)).toHaveLength(2);
    expect(html).toContain("<p>Second</p>");
  });
});
