import { toast } from "sonner";
import env from "~/env";
import Logger from "~/utils/Logger";

/**
 * Whether printing can produce a document-style PDF rather than printing the
 * page as it appears on screen.
 *
 * @returns true if PDF rendering is available on the server.
 */
export function canPrintAsPdf(): boolean {
  return !!env.PDF_EXPORT_ENABLED;
}

/**
 * Opens the browser's print dialog for a PDF. The PDF is loaded into a hidden
 * frame so that the page stays where it is. Browsers that cannot print a
 * frame show the PDF in a new tab instead, where it can be printed from the
 * viewer.
 *
 * @param pdf the PDF file to print.
 */
export function printPdf(pdf: Blob): void {
  const url = URL.createObjectURL(pdf);
  const frame = document.createElement("iframe");
  frame.style.cssText =
    "position: fixed; right: 0; bottom: 0; width: 0; height: 0; border: 0;";
  frame.src = url;

  const cleanup = () => {
    // Printing is asynchronous in some browsers, so the frame is kept for a
    // while rather than removed as soon as the dialog opens.
    setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 60 * 1000);
  };

  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch (err) {
      Logger.warn("Unable to print PDF in frame, opening it instead", {
        err,
      });
      window.open(url, "_blank");
    }
    cleanup();
  };

  document.body.appendChild(frame);
}

/**
 * Prints a document-style PDF, falling back to printing the page as it
 * appears on screen if the PDF cannot be created.
 *
 * @param fetchPdf loads the PDF to print.
 * @param messages the text shown while preparing and when it fails.
 * @param messages.preparing shown while the PDF is being created.
 */
export async function printAsPdf(
  fetchPdf: () => Promise<Blob>,
  messages: { preparing: string }
): Promise<void> {
  const id = toast.loading(messages.preparing);

  try {
    printPdf(await fetchPdf());
  } catch (err) {
    Logger.warn("Unable to create PDF for printing", { err });
    // Better a page that looks like the web than nothing at all.
    setTimeout(window.print, 0);
  } finally {
    toast.dismiss(id);
  }
}
