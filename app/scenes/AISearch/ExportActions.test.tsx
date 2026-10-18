import type * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "styled-components";
import copy from "copy-to-clipboard";
import { toast } from "sonner";
import theme from "@shared/styles/theme";
import { ExportActions } from "./ExportActions";
import { conversationToMarkdown } from "./exportMarkdown";
import type { Turn } from "./model";

vi.mock("copy-to-clipboard", () => ({ default: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("~/env", () => ({ default: { ENVIRONMENT: "test" } }));
const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock("~/hooks/useMediaQuery", () => ({ default: () => viewport.mobile }));
vi.mock("~/components/Button", () => ({
  default: ({
    children,
    onClick,
    disabled,
    "aria-label": ariaLabel,
  }: {
    children?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  ),
}));

const turn: Turn = {
  id: 1,
  question: "Q?",
  scope: {},
  status: "done",
  sources: null,
  blocks: [{ index: 0, kind: "paragraph", markdown: "A.", citations: [] }],
};

function mount(turns: Turn[], streaming = false, title?: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() =>
    createRoot(host).render(
      <ThemeProvider theme={theme}>
        <ExportActions turns={turns} streaming={streaming} title={title} />
      </ThemeProvider>
    )
  );
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(name)
    ) as HTMLButtonElement;
  return { host, button };
}

describe("ExportActions", () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("copies the serializer output and confirms", () => {
    const { button } = mount([turn]);
    act(() => button("Copy conversation").click());
    expect(copy).toHaveBeenCalledWith(
      conversationToMarkdown([turn], { title: "AI Search" }),
      expect.anything()
    );
    expect(toast.success).toHaveBeenCalledWith("Copied");
  });

  it("shows labelled icon buttons below desktop width", () => {
    viewport.mobile = true;
    try {
      const { host } = mount([turn]);
      const labels = [...host.querySelectorAll("button")].map((b) => [
        b.textContent,
        b.getAttribute("aria-label"),
      ]);
      expect(labels).toEqual([
        ["", "Copy conversation as Markdown"],
        ["", "Download as Markdown (.md)"],
        ["", "Print / Save as PDF"],
      ]);
    } finally {
      viewport.mobile = false;
    }
  });

  it("uses the chat title as the heading", () => {
    const { button } = mount([turn], false, "Hotel limits");
    act(() => button("Copy conversation").click());
    expect(copy).toHaveBeenCalledWith(
      conversationToMarkdown([turn], { title: "Hotel limits" }),
      expect.anything()
    );
  });

  it("downloads a Blob and revokes the object URL after a delay", () => {
    vi.useFakeTimers();
    const create = vi.fn(() => "blob:x");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const { button } = mount([turn]);
    act(() => button("Download").click());
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(revoke).toHaveBeenCalledWith("blob:x");
    vi.useRealTimers();
  });

  it("prints", () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    const { button } = mount([turn]);
    act(() => button("Print").click());
    expect(print).toHaveBeenCalled();
  });

  it("is disabled while streaming and when nothing is exportable", () => {
    for (const { host } of [
      mount([turn], true),
      mount([{ ...turn, blocks: [] }]),
    ]) {
      const buttons = [...host.querySelectorAll("button")];
      expect(buttons).toHaveLength(3);
      expect(buttons.every((b) => b.disabled)).toBe(true);
    }
  });

  it("labels the group", () => {
    const { host } = mount([turn]);
    expect(host.querySelector("[role=group]")?.getAttribute("aria-label")).toBe(
      "Export conversation"
    );
  });
});
