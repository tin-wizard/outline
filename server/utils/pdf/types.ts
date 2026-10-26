import type { PdfPageSize } from "@shared/types";

export type { PdfPageSize };

/** A single titled section of a printed document. */
export interface PrintChapter {
  /** The title displayed at the top of the chapter. */
  title: string;
  /** The editor HTML for the chapter, as returned by `splitHtml`. */
  body: string;
}

/** Options that control how a document is laid out on the page. */
export interface PrintOptions {
  /** The paper size, defaults to US Letter. */
  pageSize?: PdfPageSize;
  /** Text shown in the running header of every page. */
  headerTitle?: string;
}
