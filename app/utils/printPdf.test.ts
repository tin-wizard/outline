import { vi } from "vitest";
import { toast } from "sonner";
import { printAsPdf, printPdf } from "./printPdf";

vi.mock("sonner", () => ({
  toast: { loading: vi.fn(() => "toast-id"), dismiss: vi.fn() },
}));

describe("printPdf", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:pdf");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("prints the PDF from a hidden frame", () => {
    printPdf(new Blob(["%PDF-"], { type: "application/pdf" }));

    const frame = document.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("src")).toBe("blob:pdf");

    const print = vi.fn();
    Object.defineProperty(frame, "contentWindow", {
      value: { focus: vi.fn(), print },
    });
    frame?.onload?.(new Event("load"));

    expect(print).toHaveBeenCalledTimes(1);
  });

  it("opens the PDF in a tab when the frame cannot print", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    printPdf(new Blob(["%PDF-"], { type: "application/pdf" }));

    const frame = document.querySelector("iframe");
    Object.defineProperty(frame, "contentWindow", {
      value: {
        focus: vi.fn(),
        print: () => {
          throw new Error("blocked");
        },
      },
    });
    frame?.onload?.(new Event("load"));

    expect(open).toHaveBeenCalledWith("blob:pdf", "_blank");
  });
});

describe("printAsPdf", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("falls back to printing the page when the PDF fails", async () => {
    vi.useFakeTimers();
    const print = vi.fn();
    vi.stubGlobal("print", print);

    await printAsPdf(() => Promise.reject(new Error("failed")), {
      preparing: "Preparing",
    });
    vi.runAllTimers();

    expect(print).toHaveBeenCalledTimes(1);
    expect(toast.dismiss).toHaveBeenCalledWith("toast-id");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
