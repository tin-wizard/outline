import fs from "node:fs";
import { chromium } from "playwright-core";
import env from "@server/env";
import PdfRenderer from "./PdfRenderer";
import { buildPrintDocument } from "./PrintDocument";

const executablePath =
  env.PDF_EXPORT_CHROMIUM_PATH ?? chromium.executablePath();

// Rendering needs a Chromium install, which is not present in every environment.
describe.runIf(fs.existsSync(executablePath))("PdfRenderer", () => {
  it("renders HTML to a PDF", async () => {
    const html = buildPrintDocument(
      "",
      [{ title: "Test", body: "<p>Hello world</p>" }],
      "Test"
    );
    const pdf = await PdfRenderer.render(html, { pageSize: "A4" });

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  }, 60000);
});
