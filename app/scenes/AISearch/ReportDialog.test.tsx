import type * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "styled-components";
import theme from "@shared/styles/theme";
import { MAX_REPORT_COMMENT, REPORT_REASONS } from "./model";
import { ReportDialog } from "./ReportDialog";

vi.mock("~/components/Button", () => ({
  default: ({
    children,
    onClick,
    type,
    disabled,
  }: {
    children?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    type?: "button" | "submit";
    disabled?: boolean;
  }) => (
    <button type={type ?? "button"} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

describe("ReportDialog", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const onSubmit =
    vi.fn<(reason: string, comment: string) => Promise<boolean>>();
  const onClose = vi.fn();

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    onSubmit.mockReset();
    onClose.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root.render(
        <ThemeProvider theme={theme}>
          <ReportDialog onSubmit={onSubmit} onClose={onClose} />
        </ThemeProvider>
      )
    );
  });

  afterEach(async () => {
    // Radix moves focus back on a timer after unmount; let it run in this test.
    await act(async () => {
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    host.remove();
  });

  const dialog = () => document.querySelector('[role="dialog"]');
  const radios = () => [
    ...document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  ];
  const button = (text: string) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent === text
    );

  it("lists every reason from the enum, with the first selected", () => {
    expect(dialog()).not.toBeNull();
    expect(radios().map((r) => r.value)).toEqual([...REPORT_REASONS]);
    expect(radios().map((r) => r.checked)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(document.querySelector("textarea")?.getAttribute("maxlength")).toBe(
      String(MAX_REPORT_COMMENT)
    );
  });

  it("sends the chosen reason and the comment", async () => {
    onSubmit.mockResolvedValue(true);
    act(() => radios()[2].click());
    const textarea = document.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set?.call(textarea, "The policy changed in September.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Send report")!.click());
    expect(onSubmit).toHaveBeenCalledWith(
      "outdated",
      "The policy changed in September."
    );
  });

  it("sends the default reason without a comment", async () => {
    onSubmit.mockResolvedValue(true);
    await act(async () => button("Send report")!.click());
    expect(onSubmit).toHaveBeenCalledWith("inaccurate", "");
  });

  it("stays open with a message when sending fails", async () => {
    onSubmit.mockResolvedValue(false);
    await act(async () => button("Send report")!.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't send your report. Try again."
    );
    expect(dialog()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cancels without sending", () => {
    act(() => button("Cancel")!.click());
    expect(onClose).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
