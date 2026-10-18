import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "styled-components";
import theme from "@shared/styles/theme";
import { client } from "~/utils/ApiClient";
import type { Scope } from "./model";
import { CollectionsPanel, DatePanel, DocumentsPanel } from "./ScopePanels";
import { ScopeChips } from "./ScopeChips";

vi.mock("~/utils/ApiClient", () => ({ client: { post: vi.fn() } }));

const post = vi.mocked(client.post);
const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= ResizeObserverStub;
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ data: [] });
});

afterEach(() => {
  document.body.innerHTML = "";
});

const collections = Array.from({ length: 12 }, (_, i) => ({
  id: ID(i + 1),
  name: `Collection ${i + 1}`,
  icon: <i />,
}));

/** Renders a component that owns the scope state, like the page does. */
function mount(
  render: (scope: Scope, setScope: (s: Scope) => void) => React.ReactNode,
  initial: Scope = {}
) {
  const seen: { scope: Scope } = { scope: initial };
  function Harness() {
    const [scope, setScope] = React.useState<Scope>(initial);
    seen.scope = scope;
    return <>{render(scope, setScope)}</>;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <ThemeProvider theme={theme}>
        <Harness />
      </ThemeProvider>
    )
  );
  return { host, seen };
}

const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

function change(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  act(() => {
    set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const checkbox = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].find(
    (el) => el.closest("label")?.textContent?.includes(label)
  );

describe("CollectionsPanel", () => {
  it("selects several collections, caps at ten and says so", () => {
    const { host, seen } = mount((scope, setScope) => (
      <CollectionsPanel
        collections={collections}
        scope={scope}
        onChange={setScope}
      />
    ));
    for (let i = 1; i <= 10; i++) {
      act(() => checkbox(host, `Collection ${i}`)?.click());
    }
    expect(seen.scope.collectionIds).toHaveLength(10);
    expect(checkbox(host, "Collection 11")?.disabled).toBe(true);
    expect(host.textContent).toContain("You can choose up to 10 collections.");
    act(() => checkbox(host, "Collection 3")?.click());
    expect(seen.scope.collectionIds).toHaveLength(9);
    expect(checkbox(host, "Collection 11")?.disabled).toBe(false);
  });

  it("All collections clears the choice, and choosing replaces specific documents", () => {
    const { host, seen } = mount(
      (scope, setScope) => (
        <CollectionsPanel
          collections={collections}
          scope={scope}
          onChange={setScope}
        />
      ),
      { documents: [{ id: ID(50), title: "Doc" }] }
    );
    expect(host.textContent).toContain(
      "Choosing collections replaces any specific documents."
    );
    act(() => checkbox(host, "Collection 2")?.click());
    expect(seen.scope).toMatchObject({
      collectionIds: [ID(2)],
      documents: [],
    });
    act(() => checkbox(host, "All collections")?.click());
    expect(seen.scope.collectionIds).toEqual([]);
  });

  it("filters the list by name", () => {
    const { host } = mount((scope, setScope) => (
      <CollectionsPanel
        collections={collections}
        scope={scope}
        onChange={setScope}
      />
    ));
    const search = host.querySelector<HTMLInputElement>("input[type=search]");
    change(search as HTMLInputElement, "Collection 12");
    expect(checkbox(host, "Collection 12")).toBeTruthy();
    expect(checkbox(host, "Collection 1 ")).toBeUndefined();
    change(search as HTMLInputElement, "zzz");
    expect(host.textContent).toContain("No collections found");
  });
});

describe("DocumentsPanel", () => {
  it("searches, picks documents, clears collections and removes a pick", async () => {
    post.mockResolvedValue({
      data: [
        { id: ID(1), title: "Travel Policy", collectionName: "Finance" },
        { id: ID(2), title: "Expenses" },
      ],
    });
    const { host, seen } = mount(
      (scope, setScope) => <DocumentsPanel scope={scope} onChange={setScope} />,
      { collectionIds: [ID(90)] }
    );
    await tick();
    expect(host.textContent).toContain("Finance");
    act(() => checkbox(host, "Travel Policy")?.click());
    act(() => checkbox(host, "Expenses")?.click());
    expect(seen.scope.documents?.map((d) => d.title)).toEqual([
      "Travel Policy",
      "Expenses",
    ]);
    expect(seen.scope.collectionIds).toEqual([]);
    expect(host.textContent).toContain(
      "Choosing documents replaces the collection scope."
    );
    const remove = host.querySelector<HTMLButtonElement>(
      "button[aria-label='Remove Travel Policy from the scope']"
    );
    act(() => remove?.click());
    expect(seen.scope.documents?.map((d) => d.title)).toEqual(["Expenses"]);
  });

  it("caps at twenty documents", async () => {
    post.mockResolvedValue({
      data: Array.from({ length: 21 }, (_, i) => ({
        id: ID(i + 1),
        title: i === 20 ? "Extra" : `Doc ${i + 1}`,
      })),
    });
    const { host, seen } = mount(
      (scope, setScope) => <DocumentsPanel scope={scope} onChange={setScope} />,
      {
        documents: Array.from({ length: 20 }, (_, i) => ({
          id: ID(i + 100),
          title: `Picked ${i}`,
        })),
      }
    );
    await tick();
    expect(checkbox(host, "Extra")?.disabled).toBe(true);
    expect(seen.scope.documents).toHaveLength(20);
    expect(host.textContent).toContain("You can choose up to 20 documents.");
  });

  it("shows empty and error states, and retries", async () => {
    const { host } = mount((scope, setScope) => (
      <DocumentsPanel scope={scope} onChange={setScope} />
    ));
    await tick();
    expect(host.textContent).toContain("No documents found");
    post.mockRejectedValueOnce(new Error("x"));
    const search = host.querySelector<HTMLInputElement>("input[type=search]");
    change(search as HTMLInputElement, "ab");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(host.querySelector("[role=alert]")?.textContent).toContain(
      "Couldn't load documents."
    );
    post.mockResolvedValueOnce({ data: [{ id: ID(1), title: "Found" }] });
    const retry = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Try again"
    );
    await act(async () => retry?.click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(checkbox(host, "Found")).toBeTruthy();
  });

  it("requests nothing while closed", async () => {
    mount((scope, setScope) => (
      <DocumentsPanel scope={scope} onChange={setScope} open={false} />
    ));
    await tick();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("DatePanel", () => {
  const radio = (host: HTMLElement, label: string) =>
    [...host.querySelectorAll<HTMLInputElement>("input[type=radio]")].find(
      (el) => el.closest("label")?.textContent === label
    );
  const dates = (host: HTMLElement) => [
    ...host.querySelectorAll<HTMLInputElement>("input[type=date]"),
  ];

  it("offers any time, presets and a custom range", () => {
    const { host, seen } = mount((scope, setScope) => (
      <DatePanel scope={scope} onChange={setScope} />
    ));
    expect(
      [...host.querySelectorAll("label")].map((l) => l.textContent)
    ).toEqual([
      "Any time",
      "Past week",
      "Past month",
      "Past year",
      "Custom range",
    ]);
    act(() => radio(host, "Past month")?.click());
    expect(seen.scope.datePreset).toBe("month");
    act(() => radio(host, "Any time")?.click());
    expect(seen.scope.datePreset).toBeUndefined();
  });

  it("validates a custom range: order, and nothing committed while invalid", () => {
    const { host, seen } = mount((scope, setScope) => (
      <DatePanel scope={scope} onChange={setScope} />
    ));
    act(() => radio(host, "Custom range")?.click());
    expect(seen.scope.datePreset).toBe("custom");
    const [from, to] = dates(host);
    change(from, "2026-09-10");
    expect(seen.scope.dateFrom).toBe("2026-09-10");
    change(to, "2026-09-01");
    expect(host.querySelector("[role=alert]")?.textContent).toContain(
      "The start date must be on or before the end date."
    );
    expect(from.getAttribute("aria-invalid")).toBe("true");
    // The invalid end date was not applied.
    expect(seen.scope.dateTo).toBeUndefined();
    change(to, "2026-09-30");
    expect(host.querySelector("[role=alert]")).toBeNull();
    expect(seen.scope).toMatchObject({
      dateFrom: "2026-09-10",
      dateTo: "2026-09-30",
    });
  });
});

describe("ScopeChips", () => {
  const render = (
    scope: Scope,
    onChange: (s: Scope) => void,
    compare = false
  ) => (
    <ScopeChips
      scope={scope}
      onChange={onChange}
      collections={collections}
      compareEnabled={compare}
    />
  );
  const labels = (host: HTMLElement) =>
    [...host.querySelectorAll("[role=group] > button")].map((b) =>
      b.textContent?.trim()
    );

  it("labels the chips for each scope", () => {
    const none = mount((scope, set) => render(scope, set));
    expect(labels(none.host)).toEqual([
      "All collections",
      "Specific documents",
      "Any time",
    ]);
    document.body.innerHTML = "";
    const two = mount((scope, set) => render(scope, set), {
      collectionIds: [ID(1), ID(2)],
      datePreset: "week",
    });
    expect(labels(two.host)).toEqual([
      "Collection 1, Collection 2",
      "Specific documents",
      "Past week",
    ]);
    document.body.innerHTML = "";
    const three = mount((scope, set) => render(scope, set), {
      collectionIds: [ID(1), ID(2), ID(3)],
    });
    expect(labels(three.host)[0]).toBe("3 collections");
    document.body.innerHTML = "";
    const docs = mount((scope, set) => render(scope, set), {
      documents: [
        { id: ID(1), title: "A" },
        { id: ID(2), title: "B" },
      ],
    });
    expect(labels(docs.host)[1]).toBe("2 documents");
  });

  it("opens the collections menu from its chip", async () => {
    const { host, seen } = mount((scope, set) => render(scope, set));
    const trigger = host.querySelector<HTMLButtonElement>(
      "[role=group] > button"
    );
    await act(async () => trigger?.click());
    await tick();
    const first = checkbox(document.body, "Collection 1 ");
    expect(first || checkbox(document.body, "Collection 1")).toBeTruthy();
    act(() => checkbox(document.body, "Collection 2")?.click());
    expect(seen.scope.collectionIds).toEqual([ID(2)]);
  });

  it("toggles Compare when allowed and disables every chip while streaming", () => {
    const { host, seen } = mount((scope, set) => render(scope, set, true));
    const compare = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Compare"
    );
    act(() => compare?.click());
    expect(seen.scope.mode).toBe("compare");
    expect(compare?.getAttribute("aria-pressed")).toBe("true");
    act(() => compare?.click());
    expect(seen.scope.mode).toBeUndefined();
    document.body.innerHTML = "";
    const locked = mount((scope, set) => (
      <ScopeChips
        scope={scope}
        onChange={set}
        collections={collections}
        compareEnabled
        disabled
      />
    ));
    expect(
      [...locked.host.querySelectorAll("button")].every((b) => b.disabled)
    ).toBe(true);
  });
});
