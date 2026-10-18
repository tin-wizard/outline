import { EditorStyleHelper } from "@shared/editor/styles/EditorStyleHelper";
import { ProsemirrorHelper } from "@shared/utils/ProsemirrorHelper";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { redactSecrets } from "./redact";
import { headingOf } from "./text";

type Content = Parameters<typeof DocumentHelper.toProsemirror>[0];

const SAFE_ANCHOR = /^h-[^\s"'<>`#\\]{0,200}$/u;

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
  return sectionTargets(document, sections).map((t) => t?.id);
}

/** Longest heading text of a section target, in characters. */
export const MAX_HEADING_CHARS = 120;

/**
 * The anchor and heading text of a citation as they may be shown or stored:
 * the anchor only when it looks like an editor heading id (`h-` and nothing
 * that could leave a URL fragment; any script or emoji allowed), the heading
 * only when redaction would not change it, capped at 120 characters. Used by
 * both the live stream and the stored history so the rules cannot diverge.
 *
 * @param citation the citation's anchor and heading text, if any.
 * @returns the parts that are safe, omitted otherwise.
 */
export function safeCitationTarget(citation: {
  anchor?: string;
  heading?: string;
}): { anchor?: string; heading?: string } {
  const anchor =
    citation.anchor && SAFE_ANCHOR.test(citation.anchor)
      ? citation.anchor
      : undefined;
  const heading = citation.heading
    ? [...citation.heading].slice(0, MAX_HEADING_CHARS).join("").trim()
    : "";
  return {
    ...(anchor ? { anchor } : {}),
    ...(heading && redactSecrets(heading).text === heading ? { heading } : {}),
  };
}

/** The editor heading a section belongs to. */
export interface SectionTarget {
  /** The editor's heading id (see `sectionAnchors`). */
  id: string;
  /**
   * The heading's visible text, without Markdown syntax, at most 120
   * characters; omitted when the text itself would be redacted.
   */
  heading?: string;
}

/**
 * The editor heading of each section, paired as `sectionAnchors` describes:
 * size-split sections inherit the previous one, text before the first heading
 * and headings the redactor changed get none.
 *
 * @param document the document, or its Prosemirror data, the sections came from.
 * @param sections the (redacted) Markdown sections in document order.
 * @returns one target or undefined per section.
 */
export function sectionTargets(
  document: Content,
  sections: string[]
): (SectionTarget | undefined)[] {
  const doc = DocumentHelper.toProsemirror(document);
  const headings = ProsemirrorHelper.getAnchors(doc)
    .filter((a) => a.className === EditorStyleHelper.headingPositionAnchor)
    .map((a) => {
      const text = (doc.nodeAt(a.pos)?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const heading = [...text].slice(0, MAX_HEADING_CHARS).join("").trim();
      return {
        id: a.id,
        key: keyOf(text),
        heading:
          heading && redactSecrets(heading).text === heading
            ? heading
            : undefined,
      };
    });

  let next = 0;
  const targets: (SectionTarget | undefined)[] = [];
  for (const section of sections) {
    const heading = headingOf(section);
    if (heading === undefined) {
      targets.push(targets.at(-1));
      continue;
    }
    const key = keyOf(linkText(heading));
    const at = headings.findIndex((h, i) => i >= next && h.key === key);
    if (at === -1) {
      targets.push(undefined);
      continue;
    }
    next = at + 1;
    const found = headings[at];
    targets.push({
      id: found.id,
      ...(found.heading ? { heading: found.heading } : {}),
    });
  }
  return targets;
}
