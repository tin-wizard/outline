import { createMemoryHistory } from "history";
import type * as React from "react";
import { StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Route, Router } from "react-router-dom";
import { ThemeProvider } from "styled-components";
import theme from "@shared/styles/theme";
import useAIAnswersEnabled from "~/hooks/useAIAnswersEnabled";
import useAICompareEnabled from "~/hooks/useAICompareEnabled";
import useAIHistoryEnabled from "~/hooks/useAIHistoryEnabled";
import type { StoredTurn } from "~/models/AIConversation";
import { NotFoundError } from "~/utils/errors";
import type * as StreamModule from "~/utils/streamFetch";
import { streamFetch } from "~/utils/streamFetch";
import { AISearch } from "./AISearch";
import { block, controlled, done } from "~/test/askStream";

const {
  mockFetchCollection,
  mockFetchDocument,
  mockFetchConversation,
  mockFetchPage,
  mockGetConversation,
  mockSave,
  ENG,
  HIDDEN_COLLECTION,
} = vi.hoisted(() => ({
  ENG: "3e1f2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b",
  HIDDEN_COLLECTION: "4f2a3b5c-6d7e-4f80-9bac-1d2e3f4a5b6c",
  mockFetchCollection: vi.fn(() => Promise.resolve()),
  mockFetchDocument: vi.fn(() => Promise.resolve()),
  mockFetchConversation: vi.fn(),
  mockFetchPage: vi.fn(),
  mockGetConversation: vi.fn(),
  mockSave: vi.fn((_draft: { title: string; text: string }) =>
    Promise.resolve()
  ),
}));

vi.mock("~/utils/streamFetch", async (importOriginal) => ({
  ...(await importOriginal<typeof StreamModule>()),
  streamFetch: vi.fn(),
}));
vi.mock("~/hooks/useAIAnswersEnabled", () => ({ default: vi.fn() }));
vi.mock("~/hooks/useAIHistoryEnabled", () => ({ default: vi.fn() }));
vi.mock("~/components/Icons/CollectionIcon", () => ({
  default: () => <i data-icon />,
}));
vi.mock("~/hooks/useAICompareEnabled", () => ({ default: vi.fn() }));
vi.mock("./useSaveAsDocument", () => ({
  useSaveAsDocument: () => ({ canSave: true, save: mockSave }),
}));
vi.mock("~/hooks/useMobile", () => ({ default: () => false }));
vi.mock("~/hooks/useMediaQuery", () => ({ default: () => false }));
vi.mock("~/hooks/useStores", () => {
  // Stable, like the real hook: effects depend on the stores.
  const stores = {
    collections: {
      get: (id: string) =>
        id === ENG ? { id, name: "Engineering" } : undefined,
      fetch: mockFetchCollection,
      orderedData: [
        { id: ENG, name: "Engineering", isActive: true, aiExcluded: false },
        { id: "x1", name: "Secret", isActive: true, aiExcluded: true },
        { id: "x2", name: "Old", isActive: false, aiExcluded: false },
      ],
    },
    documents: { get: () => undefined, fetch: mockFetchDocument },
    aiConversations: {
      fetch: mockFetchConversation,
      fetchPage: mockFetchPage,
      get: mockGetConversation,
    },
  };
  return { default: () => stores };
});
vi.mock("~/components/Scene", () => ({
  default: ({
    children,
    left,
    actions,
  }: {
    children?: React.ReactNode;
    left?: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <div>
      <header>
        {left}
        {actions}
      </header>
      {children}
    </div>
  ),
}));
vi.mock("~/components/Breadcrumb", () => ({
  default: ({
    actions,
    children,
  }: {
    actions: { name: string; to: string }[];
    children?: React.ReactNode;
  }) => (
    <nav aria-label="Breadcrumb">
      {actions.map((action) => (
        <a key={action.name} href={action.to}>
          {action.name}
        </a>
      ))}
      {children}
    </nav>
  ),
}));
vi.mock("~/components/Tooltip", () => ({
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
// The export menu needs the action context of the real header; it has its own tests.
vi.mock("./ExportActions", () => ({
  ExportActions: () => <button type="button">Export conversation</button>,
}));
vi.mock("~/components/Button", () => ({
  default: ({
    children,
    onClick,
    disabled,
    type,
    to: _to,
    as: _as,
    "aria-label": ariaLabel,
    "aria-pressed": ariaPressed,
  }: {
    to?: unknown;
    as?: unknown;
    children?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
    type?: "submit" | "button";
    "aria-label"?: string;
    "aria-pressed"?: boolean;
  }) => (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
    >
      {children}
    </button>
  ),
}));

const mocked = vi.mocked(streamFetch);
const enabled = vi.mocked(useAIAnswersEnabled);
const historyEnabled = vi.mocked(useAIHistoryEnabled);
const compareEnabled = vi.mocked(useAICompareEnabled);

const UUID = "0b8c7a4e-5b2f-4f5e-9d3a-1f2e3d4c5b6a";
const UUID2 = "1c9d8b5f-6c3a-4a6f-8e4b-2a3f4e5d6c7b";

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocked.mockReset();
  mockFetchCollection.mockClear();
  mockFetchDocument.mockClear();
  mockFetchConversation.mockReset();
  mockFetchPage.mockReset().mockResolvedValue([]);
  mockGetConversation.mockReset().mockReturnValue(undefined);
  window.sessionStorage.clear();
  enabled.mockReturnValue(true);
  historyEnabled.mockReturnValue(false);
  compareEnabled.mockReturnValue(false);
  mockSave.mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(url: string, { strict = false } = {}) {
  const history = createMemoryHistory({ initialEntries: [url] });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const tree = (
    <ThemeProvider theme={theme}>
      <Router history={history}>
        <Route path="/ai/:conversationId?" component={AISearch} />
        <Route exact path="/home" render={() => <p>home</p>} />
      </Router>
    </ThemeProvider>
  );
  const render = () =>
    act(() => root.render(strict ? <StrictMode>{tree}</StrictMode> : tree));
  render();
  return { history, host, root };
}

const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

describe("AISearch page", () => {
  it("auto-submits q once under StrictMode and removes q from the URL", async () => {
    const stream = controlled();
    const { history } = mount(
      `/ai?q=hello&collectionId=${UUID}&documentId=${UUID2}`,
      { strict: true }
    );
    await tick();
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked.mock.calls[0][1]).toMatchObject({
      query: "hello",
      documentIds: [UUID2],
    });
    // A document is narrower than its collection: the document wins.
    expect(mocked.mock.calls[0][1]).not.toHaveProperty("collectionIds");
    // The simulated unmount must not abort the live request.
    expect(stream.signal?.aborted).toBe(false);
    const params = new URLSearchParams(history.location.search);
    expect(params.has("q")).toBe(false);
    expect(params.get("collectionId")).toBe(UUID);
    expect(params.get("documentId")).toBe(UUID2);
    expect(history.location.pathname).toBe("/ai");
    await stream.end();
  });

  it("sends nothing when the page is reloaded after q was removed", async () => {
    const stream = controlled();
    const first = mount(`/ai?q=hello&collectionId=${UUID}`);
    await tick();
    await stream.end();
    expect(mocked).toHaveBeenCalledTimes(1);
    const url = first.history.location.pathname + first.history.location.search;
    expect(url).not.toContain("q=");
    act(() => first.root.unmount());
    mount(url);
    await tick();
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("does not submit without q", async () => {
    mount("/ai");
    await tick();
    expect(mocked).not.toHaveBeenCalled();
  });

  it("drops scope ids that are not UUIDs before fetching or submitting", async () => {
    controlled();
    mount(`/ai?q=hi&collectionId=../x&documentId=not-a-uuid`);
    await tick();
    expect(mockFetchCollection).not.toHaveBeenCalled();
    expect(mockFetchDocument).not.toHaveBeenCalled();
    const body = mocked.mock.calls[0][1];
    expect(body).toMatchObject({ query: "hi" });
    expect(body).not.toHaveProperty("collectionId", "../x");
    expect(JSON.stringify(body)).not.toContain("not-a-uuid");
  });

  it("fetches valid scope ids", async () => {
    controlled();
    mount(`/ai?q=hi&collectionId=${UUID}`);
    await tick();
    expect(mockFetchCollection).toHaveBeenCalledWith(UUID);
    expect(mocked.mock.calls[0][1]).toMatchObject({ collectionIds: [UUID] });
    document.body.innerHTML = "";
    mount(`/ai?q=hi&documentId=${UUID2}`);
    await tick();
    expect(mockFetchDocument).toHaveBeenCalledWith(UUID2);
  });

  it("redirects home when AI answers are not enabled", async () => {
    enabled.mockReturnValue(false);
    const { history, host } = mount("/ai?q=hello");
    await tick();
    expect(history.location.pathname).toBe("/home");
    expect(host.textContent).toContain("home");
    expect(mocked).not.toHaveBeenCalled();
  });

  it("keeps focus in the composer after submit and moves it to the answer heading when done", async () => {
    const stream = controlled();
    const { host } = mount("/ai");
    const textarea = host.querySelector("textarea");
    if (!textarea) {
      throw new Error("no textarea");
    }
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    await act(async () => {
      setValue?.call(textarea, "What is X?");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      textarea.focus();
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      );
    });
    await tick();
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe("");

    await stream.push(block(0), done("c1"));
    await stream.end();
    expect(document.activeElement?.tagName).toBe("H2");
    expect(document.activeElement?.textContent).toBe("Answer");
  });

  it("opens the Sources drawer from a marker and fills the composer from a chip without sending", async () => {
    window.sessionStorage.clear();
    const stream = controlled();
    const { host } = mount("/ai?q=hello");
    await tick();
    const citation = {
      n: 1,
      documentId: "d1",
      title: "Doc 1",
      url: "/doc/a-abc#h-leave-policy",
      quote: "Requests go to managers.",
    };
    await stream.push(
      {
        event: "sources",
        data: [{ n: 1, documentId: "d1", title: "Doc 1", url: "/doc/a-abc" }],
      },
      {
        event: "block",
        data: {
          index: 0,
          kind: "paragraph",
          markdown: "Claim [1].",
          citations: [citation],
        },
      },
      done("c1")
    );
    await stream.end();
    expect(host.querySelector("aside")).toBeNull();
    const marker = host.querySelector<HTMLButtonElement>("[data-citation]");
    act(() => marker?.click());
    expect(host.querySelector("aside")?.textContent).toContain(
      "Requests go to managers."
    );
    const chip = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Tell me more about")
    );
    act(() => chip?.click());
    expect(host.querySelector("textarea")?.value).toBe(
      "Tell me more about leave policy"
    );
    expect(mocked).toHaveBeenCalledTimes(1);
    act(() => {
      host
        .querySelector("aside")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
    });
    expect(host.querySelector("aside")).toBeNull();
    expect(document.activeElement).toBe(marker);
  });

  it("aborts the request when the page unmounts", async () => {
    const stream = controlled();
    const { root } = mount("/ai?q=hello");
    await tick();
    expect(stream.signal?.aborted).toBe(false);
    act(() => root.unmount());
    await tick();
    expect(stream.signal?.aborted).toBe(true);
  });

  it("Stop button aborts and shows Stopped", async () => {
    const stream = controlled();
    const { host } = mount("/ai?q=hello");
    await tick();
    await stream.push({ event: "status", data: { phase: "generating" } });
    const stop = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Stop"
    );
    expect(stop).toBeTruthy();
    await act(async () => {
      stop?.click();
    });
    await tick();
    expect(stream.signal?.aborted).toBe(true);
    expect(host.textContent).toContain("Stopped");
  });

  it("fills the composer from a suggestion without sending anything", async () => {
    const { host } = mount("/ai");
    const chip = host.querySelector<HTMLButtonElement>(
      "ul[aria-label] button[value]"
    );
    if (!chip) {
      throw new Error("no suggestion");
    }
    await act(async () => chip.click());
    await tick();
    expect(mocked).not.toHaveBeenCalled();
    const textarea = host.querySelector("textarea");
    expect(textarea?.value).toBe(chip.value);
    expect(document.activeElement).toBe(textarea);
  });
});

const CONVERSATION = "2d0e9c6a-7a4b-4c1d-9b8e-3f4a5b6c7d8e";

const storedTurn = (patch: Partial<StoredTurn> = {}): StoredTurn => ({
  id: "t1",
  position: 0,
  question: "How do we onboard?",
  outcome: "answered",
  usageId: null,
  createdAt: "2026-10-18T10:00:00.000Z",
  sources: [
    { n: 1, documentId: UUID, title: "Onboarding", url: "/doc/onb-abc" },
  ],
  blocks: [
    {
      kind: "paragraph",
      markdown: "Meet your buddy [1].",
      citations: [
        {
          n: 1,
          documentId: UUID,
          title: "Old title",
          url: "/doc/onb-abc#h-day-one",
        },
      ],
    },
    { kind: "paragraph", hidden: true },
  ],
  hasHiddenBlocks: true,
  ...patch,
});

describe("AISearch page, stored conversations", () => {
  beforeEach(() => {
    historyEnabled.mockReturnValue(true);
  });

  async function type(host: HTMLElement, text: string) {
    const textarea = host.querySelector("textarea");
    if (!textarea) {
      throw new Error("no textarea");
    }
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    await act(async () => {
      setValue?.call(textarea, text);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      textarea.focus();
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      );
    });
    await tick();
  }

  it("loads /ai/:id, shows the stored turns and a notice for hidden blocks", async () => {
    mockFetchConversation.mockResolvedValue({ turns: [storedTurn()] });
    const { host } = mount(`/ai/${CONVERSATION}`);
    await tick();
    expect(mockFetchConversation).toHaveBeenCalledWith(CONVERSATION, {
      force: true,
    });
    expect(host.textContent).toContain("How do we onboard?");
    expect(host.textContent).toContain("Meet your buddy");
    expect(host.textContent).toContain(
      "This part is no longer available because a source changed or you no longer have access."
    );
    // Fresh titles from the sources replace the stored ones.
    expect(host.textContent).toContain("Onboarding");
    expect(host.textContent).not.toContain("Old title");
    expect(mocked).not.toHaveBeenCalled();
  });

  it("ignores q on a stored conversation", async () => {
    mockFetchConversation.mockResolvedValue({ turns: [storedTurn()] });
    mount(`/ai/${CONVERSATION}?q=hello`);
    await tick();
    expect(mocked).not.toHaveBeenCalled();
  });

  it("sends the conversation id with a follow-up", async () => {
    mockFetchConversation.mockResolvedValue({ turns: [storedTurn()] });
    const stream = controlled();
    const { host } = mount(`/ai/${CONVERSATION}`);
    await tick();
    await type(host, "And then?");
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked.mock.calls[0][1]).toMatchObject({
      query: "And then?",
      conversationId: CONVERSATION,
    });
    await stream.end();
  });

  it("shows Conversation not found with a New chat link on 404", async () => {
    mockFetchConversation.mockRejectedValue(new NotFoundError());
    const { host } = mount(`/ai/${CONVERSATION}`);
    await tick();
    expect(host.textContent).toContain("Conversation not found");
    const link = host.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/ai");
    expect(host.querySelector("textarea")?.closest("[hidden]")).toBeTruthy();
  });

  it("treats a malformed id as not found without a request", async () => {
    const { host } = mount("/ai/not-a-uuid");
    await tick();
    expect(mockFetchConversation).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Conversation not found");
  });

  it("offers a retry when loading fails for another reason", async () => {
    mockFetchConversation.mockRejectedValueOnce(new Error("boom"));
    mockFetchConversation.mockResolvedValueOnce({ turns: [storedTurn()] });
    const { host } = mount(`/ai/${CONVERSATION}`);
    await tick();
    const retry = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Try again"
    );
    await act(async () => retry?.click());
    await tick();
    expect(host.textContent).toContain("Meet your buddy");
  });

  it("returns to /ai with history off", async () => {
    historyEnabled.mockReturnValue(false);
    const { history } = mount(`/ai/${CONVERSATION}`);
    await tick();
    expect(history.location.pathname).toBe("/ai");
    expect(mockFetchConversation).not.toHaveBeenCalled();
  });

  it("moves a new chat to /ai/:id after its first answer without re-submitting", async () => {
    mockFetchConversation.mockResolvedValue({ turns: [] });
    const stream = controlled();
    const { history } = mount("/ai?q=hello&collectionId=" + UUID);
    await tick();
    await stream.push(block(0), done(CONVERSATION));
    await stream.end();
    expect(history.location.pathname).toBe(`/ai/${CONVERSATION}`);
    expect(history.location.search).toBe(`?collectionId=${UUID}`);
    expect(history.action).toBe("REPLACE");
    // The sidebar list is refreshed, and the stored chat is not loaded again.
    expect(mockFetchPage).toHaveBeenCalledWith({ limit: 25 });
    expect(mockFetchConversation).not.toHaveBeenCalledWith(CONVERSATION, {
      force: true,
    });
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("starts a new chat when navigating from /ai/:id to /ai", async () => {
    mockFetchConversation.mockResolvedValue({ turns: [storedTurn()] });
    const { history, host } = mount(`/ai/${CONVERSATION}`);
    await tick();
    expect(host.textContent).toContain("Meet your buddy");
    await act(async () => history.push("/ai"));
    await tick();
    expect(host.textContent).not.toContain("Meet your buddy");
    expect(mocked).not.toHaveBeenCalled();
  });
});

describe("AISearch page, shell", () => {
  const header = (host: HTMLElement) => host.querySelector("header");

  it("shows the breadcrumb at rest, with New chat for an empty chat", () => {
    const { host } = mount("/ai");
    const crumb = host.querySelector("nav[aria-label=Breadcrumb]");
    expect(crumb?.textContent).toBe("AI SearchNew chat");
    expect(crumb?.querySelector("a")?.getAttribute("href")).toBe("/ai");
    expect(header(host)?.textContent).not.toContain("Private");
    // Nothing to export or toggle before the first question.
    expect(header(host)?.querySelector("button")).toBeNull();
  });

  it("shows the stored title and a Private badge for a stored chat", async () => {
    historyEnabled.mockReturnValue(true);
    mockGetConversation.mockReturnValue({
      title: "Onboarding questions",
      createdAt: "2026-10-16T12:00:00.000Z",
      turns: [storedTurn()],
    });
    mockFetchConversation.mockResolvedValue({ turns: [storedTurn()] });
    const { host } = mount(`/ai/${CONVERSATION}`);
    await tick();
    expect(host.querySelector("nav")?.textContent).toBe(
      "AI SearchOnboarding questions"
    );
    expect(header(host)?.textContent).toContain("Private");
  });

  it("marks a resumed chat with its start date, but not a new one", async () => {
    historyEnabled.mockReturnValue(true);
    mockGetConversation.mockReturnValue({
      title: "Onboarding questions",
      createdAt: "2026-10-16T12:00:00.000Z",
      turns: [storedTurn()],
    });
    mockFetchConversation.mockResolvedValue({ turns: [storedTurn()] });
    const { host } = mount(`/ai/${CONVERSATION}`);
    await tick();
    expect(host.querySelector("[data-resumed]")?.textContent).toMatch(
      /^Resumed · started \w{3}, \w{3} 1[56]$/
    );
    expect(host.textContent).toContain("How do we onboard?");
  });

  it("shows no divider when the stored date is unusable", async () => {
    historyEnabled.mockReturnValue(true);
    mockGetConversation.mockReturnValue({
      title: "x",
      createdAt: "garbage",
      turns: [{ ...storedTurn(), createdAt: "garbage" }],
    });
    mockFetchConversation.mockResolvedValue({ turns: [storedTurn()] });
    const { host } = mount(`/ai/${CONVERSATION}`);
    await tick();
    expect(host.querySelector("[data-resumed]")).toBeNull();
    expect(host.textContent).toContain("How do we onboard?");
  });

  it("falls back to the first turn's date when the chat has no createdAt", async () => {
    historyEnabled.mockReturnValue(true);
    mockGetConversation.mockReturnValue({
      title: "x",
      turns: [storedTurn()],
    });
    mockFetchConversation.mockResolvedValue({ turns: [storedTurn()] });
    const { host } = mount(`/ai/${CONVERSATION}`);
    await tick();
    expect(host.querySelector("[data-resumed]")?.textContent).toMatch(
      /Resumed · started .*18/
    );
  });

  it("toggles the Sources drawer from the header", async () => {
    const stream = controlled();
    const { host } = mount("/ai?q=hello");
    await tick();
    await stream.push(
      {
        event: "sources",
        data: [{ n: 1, documentId: "d1", title: "Doc 1", url: "/doc/a-abc" }],
      },
      {
        event: "block",
        data: {
          index: 0,
          kind: "paragraph",
          markdown: "Claim [1].",
          citations: [
            { n: 1, documentId: "d1", title: "Doc 1", url: "/doc/a-abc#h" },
          ],
        },
      },
      done("c1")
    );
    await stream.end();
    const toggle = () =>
      host.querySelector<HTMLButtonElement>("[aria-label='Toggle sources']");
    expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector("aside")).toBeNull();
    act(() => toggle()?.click());
    expect(host.querySelector("aside")).not.toBeNull();
    expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
    act(() => toggle()?.click());
    expect(host.querySelector("aside")).toBeNull();
    expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
  });

  it("has a New chat icon link that starts over", async () => {
    historyEnabled.mockReturnValue(true);
    mockFetchConversation.mockResolvedValue({ turns: [storedTurn()] });
    const { host } = mount(`/ai/${CONVERSATION}`);
    await tick();
    const button = header(host)?.querySelector<HTMLButtonElement>(
      "[aria-label='New chat']"
    );
    expect(button).not.toBeNull();
  });
});

describe("AISearch page, empty state", () => {
  it("shows the hero, the composer under it, then 2x2 suggestions and a disclaimer", () => {
    const { host } = mount("/ai");
    expect(host.querySelector("h2")?.textContent).toBe(
      "What do you want to know?"
    );
    expect(host.textContent).toContain(
      "Answers use only documents you can access and every statement links to its source."
    );
    const list = host.querySelector("ul[aria-label]");
    expect(list?.querySelectorAll("button[value]")).toHaveLength(4);
    const textarea = host.querySelector("textarea");
    expect(
      textarea &&
        list &&
        textarea.compareDocumentPosition(list) &
          Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("drops the hero and suggestions once the chat has turns", async () => {
    historyEnabled.mockReturnValue(true);
    mockFetchConversation.mockResolvedValue({ turns: [storedTurn()] });
    const { host } = mount(`/ai/${CONVERSATION}`);
    await tick();
    expect(host.textContent).not.toContain("What do you want to know?");
    expect(host.querySelector("ul[aria-label='Example questions']")).toBeNull();
  });
});

describe("AISearch page, scope", () => {
  beforeAll(() => {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver ??= ResizeObserverStub;
  });

  const chip = (host: HTMLElement, label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("[role=group] button")].find(
      (b) => b.textContent?.includes(label)
    );

  async function send(host: HTMLElement, text: string) {
    const textarea = host.querySelector("textarea");
    if (!textarea) {
      throw new Error("no textarea");
    }
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    await act(async () => {
      setValue?.call(textarea, text);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      );
    });
    await tick();
  }

  it("prefills the chips from the URL", () => {
    const { host } = mount(`/ai?collectionId=${ENG}`);
    expect(chip(host, "Engineering")).toBeTruthy();
    expect(chip(host, "All collections")).toBeUndefined();
    expect(chip(host, "Specific documents")).toBeTruthy();
    expect(chip(host, "Any time")).toBeTruthy();
  });

  it("hides Compare unless the workspace turned it on", () => {
    expect(chip(mount("/ai").host, "Compare")).toBeUndefined();
    document.body.innerHTML = "";
    compareEnabled.mockReturnValue(true);
    expect(chip(mount("/ai").host, "Compare")).toBeTruthy();
  });

  it("asks in compare mode once Compare is on, and keeps it for later questions", async () => {
    compareEnabled.mockReturnValue(true);
    const first = controlled();
    const { host } = mount("/ai");
    const compare = chip(host, "Compare");
    act(() => compare?.click());
    expect(compare?.getAttribute("aria-pressed")).toBe("true");
    await send(host, "What changed?");
    expect(mocked.mock.calls[0][1]).toMatchObject({
      query: "What changed?",
      mode: "compare",
    });
    await first.push(done("c1"));
    await first.end();
    controlled();
    await send(host, "And now?");
    expect(mocked.mock.calls[1][1]).toMatchObject({ mode: "compare" });
  });

  it("never sends a mode when Compare is off", async () => {
    controlled();
    const { host } = mount("/ai");
    await send(host, "Hi?");
    expect(mocked.mock.calls[0][1]).not.toHaveProperty("mode");
  });

  it("shows the scope under the question, with the compare label", async () => {
    compareEnabled.mockReturnValue(true);
    const stream = controlled();
    const { host } = mount(`/ai?collectionId=${ENG}`);
    await send(host, "Scoped?");
    await stream.push({
      event: "sources",
      data: [{ n: 1, documentId: "d1", title: "Doc", url: "/doc/a-b" }],
    });
    expect(host.querySelector("article")?.textContent).toContain(
      "Engineering · Any time"
    );
    await stream.push(done("c1"));
    await stream.end();
    act(() => chip(host, "Compare")?.click());
    controlled();
    await send(host, "Compare?");
    const lines = [...host.querySelectorAll("article")].map(
      (a) => a.textContent
    );
    expect(lines[1]).toContain("Comparing documents");
  });

  it("describes hidden stored scope entries without ids", async () => {
    historyEnabled.mockReturnValue(true);
    mockFetchConversation.mockResolvedValue({
      turns: [
        storedTurn({
          scope: {
            collections: [
              { id: ENG, name: "Engineering" },
              { id: HIDDEN_COLLECTION },
            ],
            documents: [],
            dateFrom: "2026-09-01",
          },
        }),
      ],
    });
    const { host } = mount(`/ai/${CONVERSATION}`);
    await tick();
    const text = host.querySelector("article")?.textContent ?? "";
    expect(text).toContain(
      "Engineering, a collection that is no longer available · Since Sep 1, 2026"
    );
    expect(text).not.toContain(HIDDEN_COLLECTION);
    // The composer continues with what is still visible.
    expect(chip(host, "Engineering")).toBeTruthy();
  });

  it("starts over with no scope on New chat", async () => {
    const stream = controlled();
    const { host } = mount(`/ai?collectionId=${ENG}`);
    await send(host, "Q?");
    await stream.push(done(null));
    await stream.end();
    const newChat = host.querySelector<HTMLButtonElement>(
      "header [aria-label='New chat']"
    );
    await act(async () => newChat?.click());
    expect(chip(host, "All collections")).toBeTruthy();
    expect(chip(host, "Engineering")).toBeUndefined();
  });

  it("shows the compare_needs_two message calmly", async () => {
    const stream = controlled();
    const { host } = mount("/ai");
    await send(host, "Compare?");
    await stream.push({
      event: "failed",
      data: { reason: "compare_needs_two", partial: false },
    });
    await stream.end();
    expect(host.textContent).toContain(
      "Compare needs at least two documents in scope."
    );
  });

  it("saves an answer as a draft from released blocks only", async () => {
    const stream = controlled();
    const { host } = mount("/ai");
    await send(host, "How do we onboard?");
    await stream.push(
      {
        event: "sources",
        data: [{ n: 1, documentId: "d1", title: "Doc 1", url: "/doc/a-abc" }],
      },
      {
        event: "block",
        data: {
          index: 0,
          kind: "paragraph",
          markdown: "Meet your buddy [1].",
          citations: [
            {
              n: 1,
              documentId: "d1",
              title: "Doc 1",
              url: "/doc/a-abc#h-day",
              quote: "Buddy.",
            },
          ],
        },
      },
      done("c1")
    );
    await stream.end();
    const save = host.querySelector<HTMLButtonElement>(
      "button[aria-label='Save as draft document']"
    );
    await act(async () => save?.click());
    expect(mockSave).toHaveBeenCalledTimes(1);
    const draft = mockSave.mock.calls[0][0];
    expect(draft.title).toBe("How do we onboard?");
    expect(draft.text).toContain("Meet your buddy [1].");
    expect(draft.text).toContain("Sources");
  });
});
