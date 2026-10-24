import { escapeRegExp } from "es-toolkit/compat";
import type { Document, Revision } from "@server/models";
import { Attachment } from "@server/models";
import AttachmentHelper from "@server/models/helpers/AttachmentHelper";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { ProsemirrorHelper } from "@server/models/helpers/ProsemirrorHelper";
import PdfRenderer from "./PdfRenderer";
import { buildPrintDocument, splitHtml } from "./PrintDocument";
import type { PrintChapter, PrintOptions } from "./types";

/**
 * Exports documents to PDF.
 */
export default class DocumentPdfExporter {
  /**
   * Renders a single document, or a revision of one, to a PDF laid out like a
   * word processor page.
   *
   * @param model the document to export, loaded with its collaborative state, or a revision.
   * @param teamId the team the document belongs to.
   * @param options layout options for the output.
   * @returns the PDF file contents.
   */
  public static async exportDocument(
    model: Document | Revision,
    teamId: string,
    options: PrintOptions = {}
  ): Promise<Buffer> {
    const { styles, chapter } = await DocumentPdfExporter.toChapter(
      model,
      teamId
    );
    const html = buildPrintDocument(styles, [chapter], chapter.title);

    return PdfRenderer.render(html, {
      headerTitle: chapter.title,
      ...options,
    });
  }

  /**
   * Converts a document to a printable chapter, with images embedded so that
   * rendering needs no network access.
   *
   * @param model the document or revision to convert.
   * @param teamId the team the document belongs to.
   * @returns the editor styles and the chapter for the document.
   */
  private static async toChapter(
    model: Document | Revision,
    teamId: string
  ): Promise<{ styles: string; chapter: PrintChapter }> {
    let html = await DocumentHelper.toHTML(model, {
      includeTitle: false,
      centered: false,
    });

    const attachmentIds = ProsemirrorHelper.parseAttachmentIds(
      DocumentHelper.toProsemirror(model)
    );
    const attachments = attachmentIds.length
      ? await Attachment.findAll({
          where: { teamId, id: attachmentIds },
        })
      : [];

    for (const attachment of attachments) {
      if (!attachment.contentType?.startsWith("image/")) {
        continue;
      }
      const buffer = await AttachmentHelper.readBuffer(attachment);
      html = html.replace(
        new RegExp(escapeRegExp(attachment.redirectUrl), "g"),
        `data:${attachment.contentType};base64,${buffer.toString("base64")}`
      );
    }

    const { styles, body } = splitHtml(html);
    return {
      styles,
      chapter: { title: model.title || "Untitled", body },
    };
  }
}
