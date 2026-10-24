import type { PdfPageSize } from "./types";

/**
 * Page dimensions in inches for each supported paper size.
 */
export const pageDimensions: Record<
  PdfPageSize,
  { width: number; height: number }
> = {
  Letter: { width: 8.5, height: 11 },
  A4: { width: 8.27, height: 11.69 },
};

/**
 * Returns the stylesheet that gives printed output the look of a word
 * processor document rather than a web page. It is injected after the editor
 * styles, so it overrides them where the two conflict.
 *
 * @returns the CSS as a string.
 */
export function printStyles(): string {
  return `
    html, body {
      background: #fff !important;
      color: #000 !important;
      width: auto !important;
      height: auto !important;
      overflow: visible !important;
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }

    body {
      margin: 0;
      font-family: Arial, "Liberation Sans", Helvetica, sans-serif;
      font-size: 11pt;
      line-height: 1.45;
      orphans: 3;
      widows: 3;
    }

    .print-chapter + .print-chapter {
      break-before: page;
    }

    .print-chapter-title {
      margin: 0 0 18pt;
      padding: 0;
      font-size: 26pt;
      font-weight: 700;
      line-height: 1.2;
      letter-spacing: -0.01em;
      break-after: avoid;
    }

    .print-chapter-body article,
    .print-chapter-body .ProseMirror {
      max-width: none !important;
      margin: 0 !important;
      padding: 0 !important;
      color: #000 !important;
      font-family: inherit !important;
      font-size: 11pt !important;
      line-height: inherit !important;
      overflow: visible !important;
    }

    .print-chapter-body :not(pre, pre *, code, .katex, .katex *) {
      font-family: inherit !important;
    }

    .print-chapter-body p {
      margin: 0 0 8pt;
    }

    .print-chapter-body td p,
    .print-chapter-body th p {
      margin: 0;
    }

    .print-chapter-body h1,
    .print-chapter-body h2,
    .print-chapter-body h3,
    .print-chapter-body h4,
    .print-chapter-body h5,
    .print-chapter-body h6 {
      font-family: inherit;
      font-weight: 700;
      line-height: 1.25;
      margin: 18pt 0 6pt;
      break-after: avoid;
      break-inside: avoid;
    }

    .print-chapter-body h1 { font-size: 20pt; }
    .print-chapter-body h2 { font-size: 16pt; }
    .print-chapter-body h3 { font-size: 13pt; }
    .print-chapter-body h4,
    .print-chapter-body h5,
    .print-chapter-body h6 { font-size: 11pt; }

    .print-chapter-body ul,
    .print-chapter-body ol {
      margin: 0 0 8pt;
    }

    .print-chapter-body li {
      margin: 2pt 0;
    }

    .print-chapter-body a {
      color: #1155cc !important;
      text-decoration: none !important;
    }

    .print-chapter-body blockquote {
      margin: 8pt 0;
      padding: 2pt 0 2pt 12pt;
      border-left: 3pt solid #ccc;
      color: #444;
      break-inside: avoid;
    }

    .print-chapter-body hr {
      border: 0;
      border-top: 1px solid #ccc;
      margin: 14pt 0;
      height: 0;
      box-shadow: none;
    }

    .print-chapter-body pre,
    .print-chapter-body code {
      font-family: "Liberation Mono", Consolas, "Courier New", monospace;
    }

    .print-chapter-body pre {
      max-height: none !important;
      overflow: visible !important;
      white-space: pre-wrap !important;
      word-break: break-word;
      font-size: 9.5pt;
      line-height: 1.4;
      padding: 8pt 10pt;
      background: #f5f5f5 !important;
      border: 1px solid #ddd;
      border-radius: 3pt;
      break-inside: avoid;
    }

    .print-chapter-body img,
    .print-chapter-body video,
    .print-chapter-body svg {
      max-width: 100% !important;
      height: auto;
      break-inside: avoid;
    }

    .print-chapter-body figure,
    .print-chapter-body .image-wrapper {
      margin: 10pt 0;
      break-inside: avoid;
    }

    .print-chapter-body table {
      width: 100%;
      border-collapse: collapse;
      margin: 10pt 0;
      font-size: 10pt;
    }

    .print-chapter-body th,
    .print-chapter-body td {
      border: 1px solid #bbb;
      padding: 4pt 6pt;
      vertical-align: top;
    }

    .print-chapter-body th,
    .print-chapter-body th * {
      font-weight: 700 !important;
    }

    .print-chapter-body th {
      background: #f1f3f4 !important;
      text-align: left;
    }

    .print-chapter-body thead { display: table-header-group; }
    .print-chapter-body tr { break-inside: avoid; }

    .print-chapter-body button,
    .print-chapter-body .heading-actions,
    .print-chapter-body .heading-anchor {
      display: none !important;
    }
  `;
}
