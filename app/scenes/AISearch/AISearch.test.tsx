import { createMemoryHistory } from "history";
import type * as React from "react";
import { StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Route, Router } from "react-router-dom";
import { ThemeProvider } from "styled-components";
import theme from "@shared/styles/theme";
import useAIAnswersEnabled from "~/hooks/useAIAnswersEnabled";
import type * as StreamModule from "~/utils/streamFetch";
import { streamFetch } from "~/utils/streamFetch";
import { AISearch } from "./AISearch";
import { block, controlled, done } from "~/test/askStream";

vi.mock("~/utils/streamFetch", async (importOriginal) => ({
  ...(await importOriginal<typeof StreamModule>()),
  streamFetch: vi.fn(),
}));
vi.mock("~/hooks/useAIAnswersEnabled", () => ({ default: vi.fn() }));
vi.mock("~/hooks/useMobile", () => ({ default: () => false }));
vi.mock("~/hooks/useStores", () => ({
  default: () => ({
    collections: { get: () => undefined, fetch: mockFetchCollection },
    documents: { get: () => undefined, fetch: mockFetchDocument },
  }),
}));
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
  }: {
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

const mockFetchCollection = vi.fn(() => Promise.resolve());
const mockFetchDocument = vi.fn(() => Promise.resolve());
const mocked = vi.mocked(streamFetch);
const enabled = vi.mocked(useAIAnswersEnabled);

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
  enabled.mockReturnValue(true);
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
        <Route path="/ai" component={AISearch} />
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
