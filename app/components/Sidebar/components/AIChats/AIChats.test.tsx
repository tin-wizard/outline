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
import { AIChats } from "./AIChats";

vi.mock("~/hooks/useMobile", () => ({ default: () => false }));
vi.mock("~/components/DelayedMount", () => ({
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

const ID1 = "0b8c7a4e-5b2f-4f5e-9d3a-1f2e3d4c5b6a";
const ID2 = "1c9d8b5f-6c3a-4a6f-8e4b-2a3f4e5d6c7b";
const ID3 = "2d0e9c6a-7a4b-4c1d-9b8e-3f4a5b6c7d8e";

const at = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toISOString();
const row = (id: string, title: string, daysAgo: number, pinned = false) => ({
  id,
  title,
  pinnedAt: pinned ? at(0) : null,
  createdAt: at(daysAgo),
  updatedAt: at(daysAgo),
});

const reply = vi.fn();
let post: MockInstance;

beforeAll(() => {
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

const roots: Root[] = [];

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  post.mockRestore();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

async function mount(url = "/ai", deleteOnly = false) {
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
              <AIChats deleteOnly={deleteOnly} />
            </ActionContextProvider>
          </Router>
        </Provider>
      </ThemeProvider>
    )
  );
  await tick();
  return { host, history, root };
}

const links = (host: HTMLElement) =>
  [...host.querySelectorAll("a")].map((a) => [
    a.textContent,
    a.getAttribute("href"),
  ]);

describe("AIChats", () => {
  it("lists chats under their groups, pinned first, linking to /ai/:id", async () => {
    reply.mockResolvedValue({
      data: [
        row(ID1, "Leave policy", 0),
        row(ID2, "Old planning", 40),
        row(ID3, "Handbook", 20, true),
      ],
      pagination: {},
    });
    const { host } = await mount();
    const titles = [...host.querySelectorAll("h4")].map((h) => h.textContent);
    expect(titles).toEqual(["Pinned", "Today", "Older"]);
    expect(links(host)).toEqual(
      expect.arrayContaining([
        ["Handbook", `/ai/${ID3}`],
        ["Leave policy", `/ai/${ID1}`],
        ["Old planning", `/ai/${ID2}`],
      ])
    );
    expect(reply).toHaveBeenCalledWith("/aiConversations.list", {
      offset: 0,
      limit: 20,
    });
    // Pinned rows carry a pin icon; others none.
    const pinned = (title: string) =>
      !![...host.querySelectorAll("a")]
        .find((a) => a.textContent === title)
        ?.querySelector("[data-pinned]");
    expect(pinned("Handbook")).toBe(true);
    expect(pinned("Leave policy")).toBe(false);
  });

  it("has a New chat button to /ai with the Cmd+Shift+O hint", async () => {
    reply.mockResolvedValue({ data: [], pagination: {} });
    const { host } = await mount();
    const button = [...host.querySelectorAll("a")].find((a) =>
      a.textContent?.startsWith("New chat")
    );
    expect(button?.getAttribute("href")).toBe("/ai");
    expect(
      button?.querySelector("[role=img]")?.getAttribute("aria-label")
    ).toMatch(/Shift plus O$/);
  });

  it("marks the open chat as the current page", async () => {
    reply.mockResolvedValue({
      data: [row(ID1, "Leave policy", 0), row(ID2, "Other", 0)],
      pagination: {},
    });
    const { host } = await mount(`/ai/${ID1}`);
    const current = [...host.querySelectorAll("a")].filter(
      (a) => a.getAttribute("aria-current") === "page"
    );
    expect(current.map((a) => a.getAttribute("href"))).toContain(`/ai/${ID1}`);
    expect(current.map((a) => a.getAttribute("href"))).not.toContain(
      `/ai/${ID2}`
    );
  });

  it("shows an empty state", async () => {
    reply.mockResolvedValue({ data: [], pagination: {} });
    const { host } = await mount();
    expect(host.textContent).toContain("No chats yet");
    expect(host.textContent).not.toContain("Show more");
  });

  it("shows a retryable error", async () => {
    reply.mockRejectedValueOnce(new Error("boom"));
    reply.mockResolvedValueOnce({
      data: [row(ID1, "Leave policy", 0)],
      pagination: {},
    });
    const { host } = await mount();
    expect(host.querySelector("[role=alert]")?.textContent).toContain(
      "Could not load chats"
    );
    const retry = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Try again"
    );
    await act(async () => retry?.click());
    await tick();
    expect(host.textContent).toContain("Leave policy");
  });

  it("pages with Show more using the loaded count as offset", async () => {
    const first = Array.from({ length: 20 }, (_, i) => {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      return row(id, `Chat ${i}`, 0);
    });
    reply.mockResolvedValueOnce({ data: first, pagination: {} });
    reply.mockResolvedValueOnce({
      data: [row(ID1, "Last one", 50)],
      pagination: {},
    });
    const { host } = await mount();
    const more = [...host.querySelectorAll<HTMLElement>("a, button, div")].find(
      (el) => el.textContent?.startsWith("Show more") && !el.children.length
    );

    await act(async () => more?.click());
    await tick();
    expect(reply).toHaveBeenLastCalledWith("/aiConversations.list", {
      offset: 20,
      limit: 20,
    });
    expect(host.textContent).toContain("Last one");
    expect(host.textContent).not.toContain("Show more");
  });

  it("searches on the server (debounced) and shows the matches only", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    reply.mockResolvedValueOnce({
      data: [row(ID1, "Leave policy", 0), row(ID2, "Handbook", 0)],
      pagination: {},
    });
    const { host } = await mount();
    reply.mockResolvedValueOnce({
      data: [row(ID2, "Handbook", 0)],
      pagination: {},
    });
    const input = host.querySelector("input");
    if (!input) {
      throw new Error("no search input");
    }
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    await act(async () => {
      setValue?.call(input, "hand");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(reply).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(reply).toHaveBeenLastCalledWith("/aiConversations.list", {
      offset: 0,
      limit: 20,
      query: "hand",
    });
    expect(host.textContent).toContain("Handbook");
    expect(host.textContent).not.toContain("Leave policy");
  });

  it("says when a search has no results", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    reply.mockResolvedValueOnce({
      data: [row(ID1, "Leave policy", 0)],
      pagination: {},
    });
    const { host } = await mount();
    reply.mockResolvedValueOnce({ data: [], pagination: {} });
    const input = host.querySelector("input");
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    await act(async () => {
      setValue?.call(input, "zzz");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(host.textContent).toContain("No chats found");
  });

  it("reflects rename, pin and delete done through the store", async () => {
    reply.mockResolvedValue({
      data: [row(ID1, "Leave policy", 0), row(ID2, "Handbook", 1)],
      pagination: {},
    });
    const { host } = await mount();
    const [leave, handbook] = stores.aiConversations.orderedData;
    reply.mockResolvedValueOnce({ data: { ...row(ID1, "Renamed", 0) } });
    await act(async () => {
      await stores.aiConversations.rename(leave, "Renamed");
    });
    expect(host.textContent).toContain("Renamed");

    reply.mockResolvedValueOnce({
      data: { ...row(handbook.id, "Handbook", 1, true) },
    });
    await act(async () => {
      await stores.aiConversations.setPinned(handbook, true);
    });
    expect([...host.querySelectorAll("h4")].map((h) => h.textContent)).toEqual([
      "Pinned",
      "Today",
    ]);

    reply.mockResolvedValueOnce({ success: true });
    await act(async () => {
      await stores.aiConversations.delete(leave);
    });
    expect(host.textContent).not.toContain("Renamed");
  });
});

describe("AIChats with history turned off", () => {
  it("lists saved chats for deletion only, with a notice", async () => {
    reply.mockResolvedValue({
      data: [row(ID1, "Leave policy", 0), row(ID2, "Handbook", 3, true)],
      pagination: {},
    });
    const { host } = await mount("/ai", true);
    expect(host.textContent).toContain(
      "Chat history is turned off for your workspace. You can delete your saved chats here."
    );
    expect(host.textContent).toContain("Leave policy");
    // No links to resume, no search, no rename/pin/export menu.
    expect(host.querySelector('a[href^="/ai/"]')).toBeNull();
    expect(host.querySelector('input[type="search"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Chat options"]')).toBeNull();

    const openModal = vi.spyOn(stores.dialogs, "openModal");
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Delete chat “Leave policy”"]'
        )!
        .click()
    );
    expect(openModal).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Delete chat" })
    );
    openModal.mockRestore();
  });

  it("renders nothing when no chats are saved", async () => {
    reply.mockResolvedValue({ data: [], pagination: {} });
    const { host } = await mount("/ai", true);
    expect(host.textContent).toBe("");
  });
});
