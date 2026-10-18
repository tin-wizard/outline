import type { MockInstance } from "vitest";
import { createMemoryHistory } from "history";
import { Provider } from "mobx-react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { Router } from "react-router-dom";
import { ThemeProvider } from "styled-components";
import theme from "@shared/styles/theme";
import { ActionContextProvider } from "~/hooks/useActionContext";
import stores from "~/stores";
import { client } from "~/utils/ApiClient";
import { AIChatMenu } from "./AIChatMenu";

vi.mock("~/hooks/useMobile", () => ({ default: () => false }));

const ID = "0b8c7a4e-5b2f-4f5e-9d3a-1f2e3d4c5b6a";
const reply = vi.fn();
const roots: Root[] = [];
let post: MockInstance;

const row = (patch: Record<string, unknown> = {}) => ({
  id: ID,
  title: "Leave policy",
  pinnedAt: null,
  createdAt: "2026-10-18T10:00:00.000Z",
  updatedAt: "2026-10-18T10:00:00.000Z",
  ...patch,
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  globalThis.ResizeObserver = ResizeObserverStub;
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  stores.aiConversations.clear();
  reply.mockReset();
  post = vi
    .spyOn(client, "post")
    .mockImplementation((path: string, ...args: unknown[]) =>
      path.startsWith("/aiConversations")
        ? reply(path, ...args)
        : new Promise(() => undefined)
    );
});

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  post.mockRestore();
  document.body.innerHTML = "";
});

const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

async function openMenu(onRename = vi.fn(), url = "/ai") {
  const conversation = stores.aiConversations.add(row());
  const history = createMemoryHistory({ initialEntries: [url] });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      <ThemeProvider theme={theme}>
        <Provider rootStore={stores}>
          <Router history={history}>
            <ActionContextProvider value={{ activeModels: [] }}>
              <AIChatMenu conversation={conversation} onRename={onRename} />
            </ActionContextProvider>
          </Router>
        </Provider>
      </ThemeProvider>
    )
  );
  const trigger = host.querySelector("button");
  await act(async () => {
    // jsdom has no PointerEvent; Radix reads button, ctrlKey and pointerType.
    const down = new MouseEvent("pointerdown", { bubbles: true, button: 0 });
    Object.defineProperty(down, "pointerType", { value: "mouse" });
    trigger?.dispatchEvent(down);
  });
  await tick();
  return { conversation, history, onRename };
}

const item = (label: string) =>
  [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((el) =>
    el.textContent?.startsWith(label)
  );

describe("AIChatMenu", () => {
  it("offers rename, pin, export and delete", async () => {
    await openMenu();
    const labels = [...document.querySelectorAll("[role=menuitem]")].map(
      (el) => el.textContent
    );
    expect(labels).toEqual(["Rename…", "Pin", "Export as Markdown", "Delete…"]);
  });

  it("Rename starts inline editing", async () => {
    const { onRename } = await openMenu();
    await act(async () => item("Rename")?.click());
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("Pin sends pinned: true through the store", async () => {
    await openMenu();
    reply.mockResolvedValue({
      data: row({ pinnedAt: "2026-10-18T11:00:00Z" }),
    });
    await act(async () => item("Pin")?.click());
    await tick();
    expect(reply).toHaveBeenCalledWith("/aiConversations.update", {
      id: ID,
      pinned: true,
    });
    expect(stores.aiConversations.get(ID)?.isPinned).toBe(true);
  });

  it("Delete asks for confirmation before deleting", async () => {
    const openModal = vi.spyOn(stores.dialogs, "openModal");
    await openMenu();
    await act(async () => item("Delete")?.click());
    expect(openModal).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    expect(stores.aiConversations.get(ID)).toBeDefined();
    openModal.mockRestore();
  });

  it("Export fetches the turns and downloads Markdown", async () => {
    const created = vi.fn(() => "blob:x");
    URL.createObjectURL = created;
    URL.revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    await openMenu();
    reply.mockResolvedValue({
      data: {
        ...row(),
        turns: [
          {
            id: "t",
            position: 0,
            question: "Q?",
            outcome: "answered",
            usageId: null,
            createdAt: "2026-10-18T10:00:00.000Z",
            sources: [],
            blocks: [{ kind: "paragraph", markdown: "Answer.", citations: [] }],
            hasHiddenBlocks: false,
          },
        ],
      },
    });
    await act(async () => item("Export")?.click());
    await tick();
    expect(reply).toHaveBeenCalledWith("/aiConversations.info", { id: ID });
    expect(created).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it("confirming Delete removes the chat and leaves its page", async () => {
    const openModal = vi.spyOn(stores.dialogs, "openModal");
    const { history } = await openMenu(vi.fn(), `/ai/${ID}`);
    await act(async () => item("Delete")?.click());
    const modal = openModal.mock.calls[0][0];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    act(() =>
      root.render(
        <ThemeProvider theme={theme}>
          <Provider rootStore={stores}>
            <Router history={history}>
              <ActionContextProvider value={{ activeModels: [] }}>
                {modal.content}
              </ActionContextProvider>
            </Router>
          </Provider>
        </ThemeProvider>
      )
    );
    reply.mockResolvedValue({ success: true });
    await act(async () => {
      host
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        );
    });
    await tick();
    expect(reply).toHaveBeenCalledWith("/aiConversations.delete", { id: ID });
    expect(stores.aiConversations.get(ID)).toBeUndefined();
    expect(history.location.pathname).toBe("/ai");
    openModal.mockRestore();
  });
});
