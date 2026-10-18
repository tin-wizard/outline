import { createMemoryHistory } from "history";
import type * as React from "react";
import { StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Route, Router } from "react-router-dom";
import { ThemeProvider } from "styled-components";
import theme from "@shared/styles/theme";
import useAIAnswersEnabled from "~/hooks/useAIAnswersEnabled";
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
} = vi.hoisted(() => ({
  mockFetchCollection: vi.fn(() => Promise.resolve()),
  mockFetchDocument: vi.fn(() => Promise.resolve()),
  mockFetchConversation: vi.fn(),
  mockFetchPage: vi.fn(),
}));

vi.mock("~/utils/streamFetch", async (importOriginal) => ({
  ...(await importOriginal<typeof StreamModule>()),
  streamFetch: vi.fn(),
}));
vi.mock("~/hooks/useAIAnswersEnabled", () => ({ default: vi.fn() }));
vi.mock("~/hooks/useAIHistoryEnabled", () => ({ default: vi.fn() }));
vi.mock("~/hooks/useMobile", () => ({ default: () => false }));
vi.mock("~/hooks/useMediaQuery", () => ({ default: () => false }));
vi.mock("~/hooks/useStores", () => {
  // Stable, like the real hook: effects depend on the stores.
  const stores = {
    collections: { get: () => undefined, fetch: mockFetchCollection },
    documents: { get: () => undefined, fetch: mockFetchDocument },
    aiConversations: {
      fetch: mockFetchConversation,
      fetchPage: mockFetchPage,
      get: () => undefined,
    },
  };
  return { default: () => stores };
});
vi.mock("~/components/Scene", () => ({
  default: ({
    children,
    actions,
  }: {
    children?: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
}));
vi.mock("~/components/Button", () => ({
  default: ({
    children,
    onClick,
    disabled,
    type,
    to: _to,
    as: _as,
  }: {
    to?: unknown;
    as?: unknown;
    children?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: "submit" | "button";
  }) => (
    <button type={type} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

const mocked = vi.mocked(streamFetch);
const enabled = vi.mocked(useAIAnswersEnabled);
const historyEnabled = vi.mocked(useAIHistoryEnabled);

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
  enabled.mockReturnValue(true);
  historyEnabled.mockReturnValue(false);
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
      collectionId: UUID,
      documentId: UUID2,
    });
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
    mount(`/ai?q=hi&collectionId=${UUID}&documentId=${UUID2}`);
    await tick();
    expect(mockFetchCollection).toHaveBeenCalledWith(UUID);
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
