import { JSDOM } from "jsdom";
import type { PrintChapter } from "./types";
import { printStyles } from "./printStyles";

/**
 * A rendered HTML document split into its stylesheet and body markup so that
 * several documents can share a single set of styles.
 */
export interface SplitHtml {
  /** The style and stylesheet link tags of the document. */
  styles: string;
  /** The markup inside the body of the document. */
  body: string;
}

/**
 * Splits a full HTML document, as produced by `DocumentHelper.toHTML`, into
 * its styles and its body.
 *
 * @param html the full HTML document.
 * @returns the styles and body markup.
 */
export function splitHtml(html: string): SplitHtml {
  const { document } = new JSDOM(html).window;
  const styles = Array.from(
    document.querySelectorAll('style, link[rel="stylesheet"]')
  )
    .map((node) => node.outerHTML)
    .join("\n");

  for (const node of document.querySelectorAll(
    'style, link[rel="stylesheet"], script'
  )) {
    node.remove();
  }

  return { styles, body: document.body.innerHTML };
}

/**
 * Escapes text for safe inclusion in HTML.
 *
 * @param text the text to escape.
 * @returns the escaped text.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Builds the complete HTML document that is rendered to PDF. Every export,
 * whether a single page or a whole collection, goes through here so that they
 * share the same look.
 *
 * @param styles the editor styles, as returned by `splitHtml`.
 * @param chapters the titled sections to print, in order.
 * @param title the title of the whole document.
 * @returns a self-contained HTML document.
 */
export function buildPrintDocument(
  styles: string,
  chapters: PrintChapter[],
  title: string
): string {
  const sections = chapters
    .map(
      (chapter) => `
      <section class="print-chapter">
        <h1 class="print-chapter-title">${escapeHtml(chapter.title)}</h1>
        <div class="print-chapter-body">${chapter.body}</div>
      </section>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    ${styles}
    <style>${printStyles()}</style>
  </head>
  <body>${sections}</body>
</html>`;
}
