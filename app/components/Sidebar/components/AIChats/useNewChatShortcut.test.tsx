import { createMemoryHistory } from "history";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { Router } from "react-router-dom";
import { isSplitViewNavigationSuppressed } from "~/utils/splitView";
import { useNewChatShortcut } from "./useNewChatShortcut";

const roots: Root[] = [];

function Probe({ enabled }: { enabled: boolean }) {
  useNewChatShortcut(enabled);
  return null;
}

function mount(enabled: boolean) {
  const history = createMemoryHistory({ initialEntries: ["/ai/abc"] });
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  act(() =>
    root.render(
      <Router history={history}>
        <Probe enabled={enabled} />
      </Router>
    )
  );
  return history;
}

const press = (init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
};

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
});

describe("useNewChatShortcut", () => {
  it("goes to /ai on Cmd/Ctrl+Shift+O", () => {
    const history = mount(true);
    const event = press({
      key: "O",
      shiftKey: true,
      metaKey: true,
      ctrlKey: true,
    });
    expect(history.location.pathname).toBe("/ai");
    expect(event.defaultPrevented).toBe(true);
  });

  it("navigates in place, not into the split view (same modifier)", () => {
    const history = mount(true);
    const suppressed: boolean[] = [];
    history.listen(() => suppressed.push(isSplitViewNavigationSuppressed()));
    press({ key: "o", shiftKey: true, metaKey: true, ctrlKey: true });
    expect(suppressed).toEqual([true]);
  });

  it("ignores other combinations and a disabled state", () => {
    const history = mount(true);
    press({ key: "o", metaKey: true, ctrlKey: true });
    press({ key: "o", shiftKey: true });
    expect(history.location.pathname).toBe("/ai/abc");
    const off = mount(false);
    press({ key: "O", shiftKey: true, metaKey: true, ctrlKey: true });
    expect(off.location.pathname).toBe("/ai/abc");
  });
});
