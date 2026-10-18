import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "styled-components";
import theme from "@shared/styles/theme";
import { AnswerTurn } from "./AnswerTurn";
import type { Turn } from "./model";
import { SourcesDrawer } from "./SourcesDrawer";
import { useSourcesDrawer } from "./useSourcesDrawer";

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock("~/hooks/useMediaQuery", () => ({ default: () => viewport.mobile }));

vi.mock("~/components/Button", () => ({
  default: ({
    children,
    onClick,
  }: {
    children?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

const cite = (n: number, url: string, quote?: string) => ({
  n,
  documentId: `d${n}`,
  title: `Doc ${n}`,
  url,
  quote,
});

const turn: Turn = {
  id: 1,
  question: "How does leave work?",
  scope: {},
  status: "done",
  sources: [
    {
      n: 1,
      documentId: "d1",
      title: "Doc 1",
      url: "/doc/a",
      collectionName: "HR",
    },
    { n: 2, documentId: "d2", title: "Doc 2", url: "/doc/b" },
  ],
  blocks: [
    {
      index: 0,
      kind: "paragraph",
      markdown: "Claim [1] [2].",
      citations: [
        cite(1, "/doc/a#h-leave-policy", "Requests go to managers."),
        cite(2, "/doc/b#h-pay"),
      ],
    },
  ],
};

const wrap = (node: React.ReactNode) => (
  <ThemeProvider theme={theme}>
    <MemoryRouter>{node}</MemoryRouter>
  </ThemeProvider>
);

function Harness({ onFollow }: { onFollow?: (text: string) => void }) {
  const drawer = useSourcesDrawer();
  return wrap(
    <div>
      <button
        id="marker"
        type="button"
        onClick={(event) => drawer.show(1, 2, event.currentTarget)}
      >
        open
      </button>
      {drawer.open && (
        <SourcesDrawer
          turn={turn}
          selected={drawer.selected}
          autoFocus={drawer.focusIn}
          onClose={drawer.close}
        />
      )}
      <span data-follow>{String(!!onFollow)}</span>
    </div>
  );
}

describe("SourcesDrawer", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    window.sessionStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const marker = () => host.querySelector<HTMLButtonElement>("#marker")!;
  const drawerEl = () => host.querySelector("aside");

  it("opens at the clicked source and lists excerpts and sections", () => {
    act(() => root.render(<Harness />));
    expect(drawerEl()).toBeNull();
    act(() => marker().click());
    const aside = drawerEl()!;
    expect(aside.getAttribute("aria-labelledby")).toBe("ai-sources-title");
    expect(aside.textContent).toContain("Sources (2)");
    expect(aside.textContent).toContain("Requests go to managers.");
    expect(aside.textContent).toContain("HR");
    expect(document.activeElement?.id).toBe("drawer-source-2");
  });

  it("closes with Escape and returns focus to the marker", () => {
    act(() => root.render(<Harness />));
    marker().focus();
    act(() => marker().click());
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    expect(drawerEl()).toBeNull();
    expect(document.activeElement).toBe(marker());
  });

  it("closes with the close button", () => {
    act(() => root.render(<Harness />));
    act(() => marker().click());
    act(() =>
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Close sources"]')!
        .click()
    );
    expect(drawerEl()).toBeNull();
  });

  it("remembers it was open for the session", () => {
    act(() => root.render(<Harness />));
    act(() => marker().click());
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<Harness />));
    expect(drawerEl()).not.toBeNull();
    // restored, not user-opened: focus is not stolen
    expect(document.activeElement).toBe(document.body);
  });

  it("closes with Escape pressed anywhere, unless already handled", () => {
    act(() => root.render(<Harness />));
    act(() => marker().click());
    const handled = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    act(() => {
      document.body.dispatchEvent(handled);
    });
    expect(drawerEl()).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    expect(drawerEl()).toBeNull();
  });

  it("is a modal sheet with a backdrop on mobile", () => {
    viewport.mobile = true;
    try {
      act(() => root.render(<Harness />));
      act(() => marker().click());
      const aside = drawerEl()!;
      expect(aside.getAttribute("role")).toBe("dialog");
      expect(aside.getAttribute("aria-modal")).toBe("true");

      // Tab from the last focusable element wraps to the first.
      const focusable = aside.querySelectorAll<HTMLElement>("a[href], button");
      focusable[focusable.length - 1].focus();
      act(() => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Tab", bubbles: true })
        );
      });
      expect(document.activeElement).toBe(focusable[0]);

      act(() => host.querySelector<HTMLElement>("div[aria-hidden]")!.click());
      expect(drawerEl()).toBeNull();
    } finally {
      viewport.mobile = false;
    }
  });

  it("does not reopen by itself on a phone", () => {
    act(() => root.render(<Harness />));
    act(() => marker().click());
    act(() => root.unmount());
    const original = window.matchMedia;
    window.matchMedia = (() => ({ matches: true })) as never;
    try {
      root = createRoot(host);
      act(() => root.render(<Harness />));
      expect(drawerEl()).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  it("works when storage throws", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    act(() => root.render(<Harness />));
    act(() => marker().click());
    expect(drawerEl()).not.toBeNull();
    spy.mockRestore();
  });
});

describe("answer presentation", () => {
  const html = (t: Turn, props = {}) =>
    renderToStaticMarkup(
      wrap(
        <AnswerTurn
          turn={t}
          isLast
          scopeLabels={["Eng"]}
          onStop={() => {}}
          onRetry={() => {}}
          {...props}
        />
      )
    );

  it("shows the verification line from held data", () => {
    expect(html(turn)).toContain(
      "Verified · Based on 2 documents · 2 sources cited"
    );
  });

  it("uses singular wording for one document and one source", () => {
    const one: Turn = {
      ...turn,
      sources: [turn.sources![0]],
      blocks: [{ ...turn.blocks[0], citations: [turn.blocks[0].citations[0]] }],
    };
    expect(html(one)).toContain(
      "Verified · Based on 1 document · 1 source cited"
    );
  });

  it("shows Not fully verified for partial turns", () => {
    const out = html({ ...turn, problem: "unverified" });
    expect(out).toContain("Not fully verified");
    expect(out).not.toContain("Verified ·");
  });

  it("shows the not-covered notice instead of a badge", () => {
    const out = html({
      ...turn,
      blocks: [],
      problem: "no_answer",
    });
    expect(out).toContain("Not covered by your documents");
    expect(out).toContain("Searched in: Eng.");
    expect(out).not.toContain("Verified");
  });

  it("offers a Sources button and fill-only chips", () => {
    const out = html(turn, {
      onOpenSources: () => {},
      onFollowUp: () => {},
    });
    expect(out).toContain("Sources (2)");
    expect(out).toContain('value="Tell me more about leave policy"');
    expect(out).toContain('value="Compare these documents"');
    expect(out).not.toContain('type="submit"');
  });

  it("suggests follow-ups under the newest answer only", () => {
    const out = html(turn, {
      isLast: false,
      onOpenSources: () => {},
      onFollowUp: () => {},
    });
    expect(out).not.toContain("Tell me more about");
  });
});
