import type { MockInstance } from "vitest";
import { createMemoryHistory } from "history";
import { Provider } from "mobx-react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { Router } from "react-router-dom";
import { ThemeProvider } from "styled-components";
import copy from "copy-to-clipboard";
import { toast } from "sonner";
import theme from "@shared/styles/theme";
import { ActionContextProvider } from "~/hooks/useActionContext";
import stores from "~/stores";
import { ExportActions } from "./ExportActions";
import { conversationToMarkdown } from "./exportMarkdown";
import type { Turn } from "./model";

vi.mock("copy-to-clipboard", () => ({ default: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("~/hooks/useMobile", () => ({ default: () => false }));

const turn: Turn = {
  id: 1,
  question: "Q?",
  scope: {},
  status: "done",
  sources: null,
  blocks: [{ index: 0, kind: "paragraph", markdown: "A.", citations: [] }],
};

const roots: Root[] = [];
let print: MockInstance;

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  print = vi.spyOn(window, "print").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  vi.clearAllMocks();
  vi.useRealTimers();
  print.mockRestore();
  document.body.innerHTML = "";
});

function mount(turns: Turn[], streaming = false, title?: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      <ThemeProvider theme={theme}>
        <Provider rootStore={stores}>
          <Router history={createMemoryHistory({ initialEntries: ["/ai"] })}>
            <ActionContextProvider value={{ activeModels: [] }}>
              <ExportActions
                turns={turns}
                streaming={streaming}
                title={title}
              />
            </ActionContextProvider>
          </Router>
        </Provider>
      </ThemeProvider>
    )
  );
  const trigger = host.querySelector<HTMLButtonElement>("button");
  return { host, trigger };
}

const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

async function open(trigger: HTMLButtonElement | null) {
  await act(async () => {
    // jsdom has no PointerEvent; Radix reads button, ctrlKey and pointerType.
    const down = new MouseEvent("pointerdown", { bubbles: true, button: 0 });
    Object.defineProperty(down, "pointerType", { value: "mouse" });
    trigger?.dispatchEvent(down);
  });
  await tick();
}

const item = (label: string) =>
  [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((el) =>
    el.textContent?.includes(label)
  );

async function choose(label: string, ...mountArgs: Parameters<typeof mount>) {
  const { trigger } = mount(...mountArgs);
  await open(trigger);
  await act(async () => item(label)?.click());
}

describe("ExportActions", () => {
  it("is one labelled icon button that opens the export menu", async () => {
    const { trigger } = mount([turn]);
    expect(document.querySelectorAll("button")).toHaveLength(1);
    expect(trigger?.getAttribute("aria-label")).toBe("Export conversation");
    expect(trigger?.textContent).toBe("");
    await open(trigger);
    expect(
      [...document.querySelectorAll("[role=menuitem]")].map(
        (el) => el.textContent
      )
    ).toEqual([
      "Copy conversation as Markdown",
      "Download as Markdown (.md)",
      "Print / Save as PDF",
    ]);
  });

  it("copies the serializer output and confirms", async () => {
    await choose("Copy conversation", [turn]);
    expect(copy).toHaveBeenCalledWith(
      conversationToMarkdown([turn], { title: "AI Search" }),
      expect.anything()
    );
    expect(toast.success).toHaveBeenCalledWith("Copied");
  });

  it("uses the chat title as the heading", async () => {
    await choose("Copy conversation", [turn], false, "Hotel limits");
    expect(copy).toHaveBeenCalledWith(
      conversationToMarkdown([turn], { title: "Hotel limits" }),
      expect.anything()
    );
  });

  it("downloads a Blob and revokes the object URL after a delay", async () => {
    const create = vi.fn(() => "blob:x");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const { trigger } = mount([turn]);
    await open(trigger);
    vi.useFakeTimers();
    act(() => item("Download")?.click());
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(revoke).toHaveBeenCalledWith("blob:x");
  });

  it("prints", async () => {
    await choose("Print", [turn]);
    expect(print).toHaveBeenCalled();
  });

  it("is disabled while streaming and when nothing is exportable", () => {
    for (const { trigger } of [
      mount([turn], true),
      mount([{ ...turn, blocks: [] }]),
    ]) {
      expect(trigger?.disabled).toBe(true);
    }
  });
});
