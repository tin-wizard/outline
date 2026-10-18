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
    expect(aside.textContent).toContain("Sources");
    expect(aside.textContent).toContain("2 documents");
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

  it("shows the pill above the answer and the source count from distinct cited documents", () => {
    const out = html(turn, { onOpenSources: () => {} });
    expect(out).toContain("Verified · every statement cited");
    expect(out).toContain("2 sources");
    // the pill precedes the answer body
    expect(out.indexOf("Verified · every")).toBeLessThan(out.indexOf("Claim"));
    expect(out).not.toContain("Based on");
  });

  it("uses singular wording for one source", () => {
    const one: Turn = {
      ...turn,
      sources: [turn.sources![0]],
      blocks: [{ ...turn.blocks[0], citations: [turn.blocks[0].citations[0]] }],
    };
    expect(html(one, { onOpenSources: () => {} })).toContain("1 source<");
  });

  it("claims every statement cited only when no claim block is uncited", () => {
    const withGap: Turn = {
      ...turn,
      blocks: [
        ...turn.blocks,
        {
          index: 1,
          kind: "paragraph",
          markdown: "The documents do not cover contractors.",
          citations: [],
        },
      ],
    };
    const out = html(withGap);
    expect(out).toContain("Verified");
    expect(out).not.toContain("every statement cited");
  });

  it("shows Verified only when no statements were dropped", () => {
    expect(html({ ...turn, droppedSegments: 0 })).toContain("Verified ·");
    const out = html({ ...turn, droppedSegments: 1 });
    expect(out).toContain(
      "Some statements could not be verified and were left out."
    );
    expect(out).not.toContain("Verified");
    expect(out).not.toContain("Not fully verified");
  });

  it("labels sections and chips with the cited heading text", () => {
    const withHeadings: Turn = {
      ...turn,
      blocks: [
        {
          ...turn.blocks[0],
          citations: [
            { ...turn.blocks[0].citations[0], heading: "Annual <b>Leave</b>" },
            {
              ...cite(1, "/doc/a#h-overview-1"),
              heading: "Overview",
            },
          ],
        },
      ],
    };
    const out = html(withHeadings, {
      onOpenSources: () => {},
      onFollowUp: () => {},
    });
    expect(out).toContain(
      'value="Tell me more about Annual &lt;b&gt;Leave&lt;/b&gt;"'
    );
    expect(out).toContain('value="Tell me more about Overview"');
    expect(out).not.toContain("overview 1");
    expect(out).not.toContain("<b>Leave");
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
    expect(out).toContain("2 sources");
    expect(out).toContain("Ask next");
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

describe("panel content", () => {
  const daysAgo = (days: number) =>
    new Date(Date.now() - days * 86_400_000).toISOString();

  const panel = (t: Turn): HTMLElement => {
    const el = document.createElement("div");
    el.innerHTML = renderToStaticMarkup(
      wrap(
        <SourcesDrawer
          turn={t}
          selected={1}
          autoFocus={false}
          onClose={() => {}}
        />
      )
    );
    return el;
  };

  const detailed: Turn = {
    ...turn,
    sources: [
      {
        n: 1,
        documentId: "d1",
        title: "Doc 1",
        url: "/doc/a",
        collectionName: "Engineering",
        collectionColor: "#3633ff",
        updatedAt: "2026-10-14T10:00:00.000Z",
      },
      {
        n: 2,
        documentId: "d2",
        title: "Doc 2",
        url: "/doc/b",
        collectionName: "Partners",
        updatedAt: daysAgo(200),
      },
    ],
    blocks: [
      {
        index: 0,
        kind: "paragraph",
        markdown: "One.",
        citations: [
          cite(1, "/doc/a#h-authentication", "client-credentials grant"),
        ],
      },
      {
        index: 1,
        kind: "listItem",
        markdown: "Two.",
        citations: [cite(1, "/doc/a#h-examples"), cite(2, "/doc/b#h-pay")],
      },
      {
        index: 2,
        kind: "paragraph",
        markdown: "Three.",
        citations: [cite(2, "/doc/b#h-pay")],
      },
    ],
  };

  const banner = (t: Turn) =>
    panel(t).querySelector('[role="note"]')?.textContent;

  it("counts released statements and cited documents in the coverage banner", () => {
    expect(banner(detailed)).toBe(
      "All 3 statements match a passage in these 2 documents."
    );
    const one: Turn = {
      ...detailed,
      sources: [detailed.sources![0]],
      blocks: [detailed.blocks[0]],
    };
    expect(banner(one)).toBe(
      "The statement matches a passage in this document."
    );
    expect(
      banner({
        ...detailed,
        blocks: detailed.blocks
          .slice(0, 2)
          .map((b) => ({ ...b, citations: b.citations.slice(0, 1) })),
      })
    ).toBe("All 2 statements match a passage in this document.");
  });

  it("never says all statements match when something was dropped, is a gap or failed", () => {
    for (const patch of [
      { droppedSegments: 1 },
      { problem: "unverified" as const },
    ]) {
      expect(banner({ ...detailed, ...patch })).not.toMatch(
        /^All|matches a passage/
      );
    }
    expect(banner({ ...detailed, droppedSegments: 2 })).toBe(
      "Some statements could not be verified and were left out."
    );
    expect(
      banner({
        ...detailed,
        blocks: [
          ...detailed.blocks,
          {
            index: 3,
            kind: "paragraph",
            markdown: "The documents do not cover contractors.",
            citations: [],
          },
        ],
      })
    ).toBe("Part of your question isn't covered by these documents.");
    expect(banner({ ...detailed, problem: "timeout" })).toBe(
      "This answer is incomplete, so not every part was verified."
    );
  });

  it("builds a card per source with collection colour, update day, sections and highlighted excerpt", () => {
    const el = panel(detailed);
    const cards = el.querySelectorAll("li");
    expect(cards).toHaveLength(2);
    const first = cards[0];
    expect(first.getAttribute("aria-current")).toBe("true");
    expect(first.textContent).toContain("Doc 1");
    expect(first.textContent).toContain("Engineering");
    expect(first.querySelector("i")?.getAttribute("style")).toContain(
      "#3633ff"
    );
    expect(first.textContent).toContain("Updated Oct 14, 2026");
    expect(first.textContent).toContain("§ authentication");
    expect(first.textContent).toContain("§ examples");
    expect(
      [...first.querySelectorAll("a")].map((a) => a.getAttribute("href"))
    ).toEqual([
      "/doc/a#h-authentication",
      "/doc/a#h-authentication",
      "/doc/a#h-examples",
    ]);
    expect(first.querySelector("mark")?.textContent).toBe(
      "client-credentials grant"
    );
    expect(first.textContent).toContain("Cited 2× in this answer");
    expect(cards[1].getAttribute("aria-current")).toBeNull();
  });

  it("flags a source not updated for more than 180 days, and only then", () => {
    const cards = panel(detailed).querySelectorAll("li");
    expect(cards[0].textContent).not.toContain("Not updated in 180+ days");
    expect(cards[1].textContent).toContain("Not updated in 180+ days");
  });

  it("keeps hostile titles, headings and excerpts literal and links only safe paths", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const t: Turn = {
      ...detailed,
      sources: [
        { ...detailed.sources![0], title: evil, collectionName: "<b>x</b>" },
      ],
      blocks: [
        {
          index: 0,
          kind: "paragraph",
          markdown: "One.",
          citations: [
            {
              ...cite(
                1,
                "javascript:alert(1)",
                "[x](javascript:alert(1)) <script>1</script>"
              ),
              title: evil,
              heading: "<i>h</i>",
            },
          ],
        },
      ],
    };
    const el = panel(t);
    expect(el.querySelector("img, script, b, i:not([style])")).toBeNull();
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain(evil);
    expect(el.textContent).toContain("§ <i>h</i>");
    expect(el.querySelector("mark")?.textContent).toBe(
      "[x](javascript:alert(1)) <script>1</script>"
    );
  });

  it("states the retrieval counts as candidates and used, never as documents searched", () => {
    const text = (t: Turn) => panel(t).textContent ?? "";
    expect(
      text({ ...detailed, retrieval: { fetched: 20, used: 5 } })
    ).toContain("20 candidates · 5 used");
    expect(text({ ...detailed, retrieval: { fetched: 1, used: 1 } })).toContain(
      "1 candidate · 1 used"
    );
    expect(
      text({ ...detailed, retrieval: { fetched: 20, used: 5 } })
    ).not.toMatch(/searched \d+ documents/i);
  });

  it("lists sources found but not cited with their titles", () => {
    const t: Turn = {
      ...detailed,
      retrieval: { fetched: 9, used: 4 },
      sources: [
        ...detailed.sources!,
        { n: 3, documentId: "d3", title: "BOSS Changelog", url: "/doc/c" },
        { n: 4, documentId: "d4", title: "Partner Onboarding", url: "/doc/d" },
      ],
    };
    const details = panel(t).querySelector("details");
    expect(details?.querySelector("summary")?.textContent).toBe(
      "9 candidates · 4 used"
    );
    expect(details?.textContent).toContain("2 found but not cited");
    expect(details?.textContent).toContain("BOSS Changelog");
    expect(details?.textContent).toContain("Partner Onboarding");
    // without stored retrieval counts (older chats) only the uncited line remains
    const older = panel({ ...t, retrieval: undefined }).querySelector(
      "summary"
    );
    expect(older?.textContent).toBe("2 found but not cited");
    expect(
      panel({
        ...t,
        sources: [t.sources![0], t.sources![1]],
        retrieval: undefined,
      }).querySelector("details")
    ).toBeNull();
  });

  it("renders resumed turns that lack the new fields", () => {
    const old: Turn = {
      ...turn,
      sources: [
        { n: 1, documentId: "d1", title: "Doc 1", url: "/doc/a" },
        { n: 2, documentId: "d2", title: "Doc 2", url: "/doc/b" },
      ],
    };
    const el = panel(old);
    expect(el.querySelectorAll("li")).toHaveLength(2);
    expect(el.textContent).not.toContain("Updated");
    expect(el.textContent).not.toContain("candidates");
  });

  it("shows retrieved sources while the answer is still being written", () => {
    const el = panel({ ...detailed, status: "generating", blocks: [] });
    expect(el.textContent).toContain("Reading sources…");
    expect(el.textContent).toContain("Doc 1");
    expect(el.querySelector('[role="note"]')).toBeNull();
  });
});
