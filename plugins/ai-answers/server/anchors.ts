import { EditorStyleHelper } from "@shared/editor/styles/EditorStyleHelper";
import { ProsemirrorHelper } from "@shared/utils/ProsemirrorHelper";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { headingOf } from "./text";

type Content = Parameters<typeof DocumentHelper.toProsemirror>[0];

// Comparison key: letters and digits only, so markdown escapes, emphasis
// markers and emoji cannot make an editor heading and its Markdown differ.
const keyOf = (text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Markdown inline links and images keep only their visible text. */
const linkText = (markdown: string) =>
  markdown.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");

/**
 * Computes the editor's own heading id for each section, so a citation link
 * lands on the heading the user sees. Ids come from `ProsemirrorHelper.getAnchors`
 * (text content, occurrence suffix over all headings in document order); the
 * sections are only used to find which editor heading each one starts with.
 * A section without its own heading (a size split) inherits the previous
 * section's anchor; text before the first heading has none. A heading whose
 * Markdown no longer matches the editor's text, because the redactor changed
 * it, gets none, so a secret never reaches a URL fragment.
 *
 * shortcut: headings are paired with sections by normalised text in document
 * order, so an entity-encoded heading (`&amp;`) goes without an anchor; use
 * source positions if that matters.
 *
 * @param document the document, or its Prosemirror data, the sections came from.
 * @param sections the (redacted) Markdown sections in document order.
 * @returns one anchor id (no `#`) or undefined per section.
 */
export function sectionAnchors(
  document: Content,
  sections: string[]
): (string | undefined)[] {
  const doc = DocumentHelper.toProsemirror(document);
  const headings = ProsemirrorHelper.getAnchors(doc)
    .filter((a) => a.className === EditorStyleHelper.headingPositionAnchor)
    .map((a) => ({
      id: a.id,
      key: keyOf(doc.nodeAt(a.pos)?.textContent ?? ""),
    }));

  let next = 0;
  const anchors: (string | undefined)[] = [];
  for (const section of sections) {
    const heading = headingOf(section);
    if (heading === undefined) {
      anchors.push(anchors.at(-1));
      continue;
    }
    const key = keyOf(linkText(heading));
    const at = headings.findIndex((h, i) => i >= next && h.key === key);
    if (at === -1) {
      anchors.push(undefined);
      continue;
    }
    next = at + 1;
    anchors.push(headings[at].id);
  }
  return anchors;
}
