import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { buildDocument } from "@server/test/factories";
import { sectionAnchors, sectionTargets } from "./anchors";
import { redactSecrets } from "./redact";
import { splitIntoSections } from "./text";

async function anchorsFor(text: string, maxChars?: number) {
  const document = await buildDocument({ text });
  const { text: markdown } = redactSecrets(
    await DocumentHelper.toMarkdown(document, { includeTitle: false })
  );
  const sections = splitIntoSections(markdown, maxChars);
  return { sections, anchors: sectionAnchors(document, sections) };
}

describe("sectionAnchors", () => {
  it("gives the second occurrence of a repeated heading the -1 suffix", async () => {
    const { anchors } = await anchorsFor(
      "# Installation\nmac\n\n# Usage\nrun\n\n# Installation\nlinux"
    );
    expect(anchors).toEqual(["h-installation", "h-usage", "h-installation-1"]);
  });

  it("uses the link text of a heading containing a markdown link", async () => {
    const { anchors } = await anchorsFor(
      "## See [docs](https://example.com)\nmore"
    );
    expect(anchors).toEqual(["h-see-docs"]);
  });

  it("matches headings with bold, code, emoji and non-ASCII text", async () => {
    const { anchors } = await anchorsFor(
      "## **Bold** and `code`\na\n\n## Café 🎉 Überblick\nb\n\n## 日本語\nc"
    );
    expect(anchors).toEqual([
      "h-bold-and-code",
      "h-cafe-🎉-uberblick",
      "h-日本語",
    ]);
  });

  it("lets size-split sections inherit the preceding heading's anchor", async () => {
    const body = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} text.`);
    const { sections, anchors } = await anchorsFor(
      `# Intro\nhi\n\n# Setup\n${body.join("\n\n")}\n\n# End\nbye`,
      50
    );
    expect(sections.length).toBeGreaterThan(4);
    const setup = sections.flatMap((s, i) =>
      s.startsWith("# Setup") ? [i] : []
    )[0];
    expect(anchors[setup + 1]).toEqual("h-setup");
    expect(anchors[setup + 2]).toEqual("h-setup");
    expect(anchors.at(-1)).toEqual("h-end");
  });

  it("leaves text before the first heading without an anchor", async () => {
    const { anchors } = await anchorsFor("Preamble text.\n\n# First\nbody");
    expect(anchors).toEqual([undefined, "h-first"]);
  });

  it("drops the anchor of a heading the redactor changed", async () => {
    const { sections, anchors } = await anchorsFor(
      "# Keys AKIAIOSFODNN7EXAMPLE\nbody\n\n# Next\nmore"
    );
    expect(sections[0]).toContain("REDACTED");
    expect(anchors).toEqual([undefined, "h-next"]);
  });
});

describe("sectionTargets headings", () => {
  async function headingsFor(text: string, maxChars?: number) {
    const document = await buildDocument({ text });
    const { text: markdown } = redactSecrets(
      await DocumentHelper.toMarkdown(document, { includeTitle: false })
    );
    const sections = splitIntoSections(markdown, maxChars);
    return {
      sections,
      headings: sectionTargets(document, sections).map((t) => t?.heading),
    };
  }

  it("returns the visible heading text without Markdown syntax", async () => {
    const { headings } = await headingsFor(
      "Preamble.\n\n## See [docs](https://example.com)\na\n\n## **Bold** and `code`\nb"
    );
    expect(headings).toEqual([undefined, "See docs", "Bold and code"]);
  });

  it("lets size-split sections inherit the heading and caps its length", async () => {
    const long = "Word ".repeat(40).trim();
    const body = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} text.`);
    const { headings } = await headingsFor(
      `# ${long}\n${body.join("\n\n")}`,
      50
    );
    expect(headings.length).toBeGreaterThan(2);
    expect(new Set(headings).size).toEqual(1);
    expect(headings[0]).toEqual(long.slice(0, 120).trim());
  });

  it("omits the heading the redactor changed", async () => {
    const { headings } = await headingsFor(
      "# Keys AKIAIOSFODNN7EXAMPLE\nbody\n\n# Next\nmore"
    );
    expect(headings).toEqual([undefined, "Next"]);
  });
});
