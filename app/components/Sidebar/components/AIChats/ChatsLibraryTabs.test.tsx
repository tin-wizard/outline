import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "styled-components";
import theme from "@shared/styles/theme";
import {
  ChatsLibraryTabs,
  readSidebarView,
  writeSidebarView,
} from "./ChatsLibraryTabs";
import type { SidebarView } from "./ChatsLibraryTabs";

const roots: Root[] = [];

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

function mount(view: SidebarView, onChange = vi.fn()) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      <ThemeProvider theme={theme}>
        <ChatsLibraryTabs view={view} onChange={onChange} />
      </ThemeProvider>
    )
  );
  const tabs = () => [...host.querySelectorAll<HTMLElement>("[role=tab]")];
  return { host, tabs, onChange };
}

describe("ChatsLibraryTabs", () => {
  it("is a tablist with Chats and Library, the current one selected", () => {
    const { host, tabs } = mount("library");
    expect(host.querySelector("[role=tablist]")).not.toBeNull();
    expect(
      tabs().map((t) => [t.textContent, t.getAttribute("aria-selected")])
    ).toEqual([
      ["Chats", "false"],
      ["Library", "true"],
    ]);
    // Roving tabindex: only the selected tab is in the tab order.
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0]);
    expect(tabs()[1].getAttribute("aria-controls")).toBeTruthy();
  });

  it("selects on click", () => {
    const { tabs, onChange } = mount("chats");
    act(() => tabs()[1].click());
    expect(onChange).toHaveBeenCalledWith("library");
  });

  it("moves with the arrow, Home and End keys", () => {
    const { tabs, onChange } = mount("chats");
    const press = (key: string) =>
      act(() => {
        tabs()[0].dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true })
        );
      });
    press("ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith("library");
    press("ArrowLeft");
    expect(onChange).toHaveBeenLastCalledWith("library");
    press("End");
    expect(onChange).toHaveBeenLastCalledWith("library");
    press("Home");
    expect(onChange).toHaveBeenLastCalledWith("chats");
  });
});

describe("sidebar view storage", () => {
  it("defaults to chats and remembers the choice for the session", () => {
    expect(readSidebarView()).toBe("chats");
    writeSidebarView("library");
    expect(readSidebarView()).toBe("library");
  });

  it("ignores junk values", () => {
    window.sessionStorage.setItem("ai-sidebar-view", "nope");
    expect(readSidebarView()).toBe("chats");
  });

  it("works without storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readSidebarView()).toBe("chats");
    expect(() => writeSidebarView("library")).not.toThrow();
  });
});
