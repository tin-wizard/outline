import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "styled-components";
import theme from "@shared/styles/theme";
import type { AskCitation } from "~/utils/streamFetch";
import { AnswerBody } from "./AnswerBody";
import { AnswerTurn } from "./AnswerTurn";
import { CitationPreview } from "./CitationPreview";
import type { Turn } from "./model";
import { citedSources, sectionLabel } from "./model";

vi.mock("~/components/Button", () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

const cite = (url: string, quote?: string, n = 1): AskCitation => ({
  n,
  documentId: "d",
  title: "Doc A",
  url,
  quote,
});

const turn = (citations: AskCitation[]): Turn => ({
  id: 1,
  question: "Q?",
  scope: {},
  status: "done",
  sources: [
    {
      n: 1,
      documentId: "d",
      title: "Doc A",
      url: "/doc/a-abc",
      collectionName: "Eng",
    },
  ],
  blocks: citations.map((c, index) => ({
    index,
    kind: "paragraph" as const,
    markdown: "Claim.",
    citations: [c],
  })),
});

const wrap = (node: React.ReactNode) => (
  <ThemeProvider theme={theme}>
    <MemoryRouter>{node}</MemoryRouter>
  </ThemeProvider>
);

function renderTurn(t: Turn): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    wrap(
      <AnswerTurn
        turn={t}
        isLast
        scopeLabels={[]}
        onStop={() => {}}
        onRetry={() => {}}
      />
    )
  );
  return host;
}

describe("sectionLabel", () => {
  it.each([
    ["/doc/a#h-leave-policy", "leave policy"],
    ["/doc/a#h-a%20b-2", "a b 2"],
    ["/doc/a#h-%E0%A4", "%E0%A4"],
    ["/doc/a", undefined],
    ["/doc/a#h-", undefined],
    ["/doc/a#other", undefined],
  ])("%s => %s", (url, label) => {
    expect(sectionLabel(url)).toBe(label);
  });
});

describe("citation excerpts", () => {
  const attacks = [
    "<img src=x onerror=alert(1)>",
    "[x](javascript:alert(1))",
    "visit example.com or https://evil.example and www.evil.example",
    "<script>alert(1)</script>",
  ];

  it.each(attacks)("keeps %s literal in the excerpt", (quote) => {
    const host = renderTurn(turn([cite("/doc/a-abc#h-x", quote)]));
    const bq = host.querySelector("blockquote");
    expect(bq?.textContent).toBe(quote);
    expect(host.querySelector("img, script, iframe")).toBeNull();
    const attrs = [...host.querySelectorAll("*")].flatMap((el) =>
      el.getAttributeNames()
    );
    expect(attrs.filter((name) => name.startsWith("on"))).toEqual([]);
    // only the title link; the quote never produces an anchor
    expect(host.querySelectorAll("a")).toHaveLength(1);
    expect(host.querySelector("a")?.getAttribute("href")).toBe(
      "/doc/a-abc#h-x"
    );
  });

  it("shows no link for unsafe urls but still shows the quote as text", () => {
    const host = renderTurn(turn([cite("javascript:alert(1)", "the quote")]));
    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector("blockquote")?.textContent).toBe("the quote");
  });

  it("lists every cited section with a heading label and its own quote", () => {
    const host = renderTurn(
      turn([
        cite("/doc/a-abc#h-intro", "first"),
        cite("/doc/a-abc#h-pricing-tiers", "second"),
        cite("/doc/a-abc#h-intro", "ignored duplicate"),
        cite("/doc/a-abc", "no anchor"),
      ])
    );
    const links = [...host.querySelectorAll("li a")];
    expect(links.map((a) => a.textContent)).toEqual([
      "Doc A",
      "pricing tiers",
      "Section 3",
    ]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/doc/a-abc#h-intro",
      "/doc/a-abc#h-pricing-tiers",
      "/doc/a-abc",
    ]);
    expect(host.querySelector("li")?.textContent).toContain("intro");
    expect(
      [...host.querySelectorAll("blockquote")].map((q) => q.textContent)
    ).toEqual(["first", "second", "no anchor"]);
  });

  it("offers expand only for long quotes", () => {
    const short = renderTurn(turn([cite("/doc/a-abc#h-x", "short")]));
    expect(short.querySelector("button[aria-expanded]")).toBeNull();
    const long = renderTurn(turn([cite("/doc/a-abc#h-x", "word ".repeat(60))]));
    expect(
      long.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")
    ).toBe("false");
  });

  it("keeps the first non-empty quote per section", () => {
    const [source] = citedSources(
      turn([
        cite("/doc/a#h-x"),
        cite("/doc/a#h-x", " later "),
        cite("/doc/a#h-x", "last"),
      ])
    );
    expect(source.sections).toEqual([{ url: "/doc/a#h-x", quote: "later" }]);
  });
});

describe("citation previews", () => {
  it("builds the card from event data as text", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      wrap(
        <CitationPreview
          id="p1"
          preview={{
            title: "<b>Doc</b>",
            collectionName: "Eng",
            quote: "<img src=x onerror=alert(1)>",
          }}
        />
      )
    );
    const tip = host.querySelector("#p1");
    expect(tip?.getAttribute("role")).toBe("dialog");
    expect(tip?.textContent).toContain("<b>Doc</b>");
    expect(tip?.textContent).toContain("Eng");
    expect(tip?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(host.querySelector("img, b, a")).toBeNull();
  });

  it("shows heading, highlighted passage, update info, count and a safe link", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      wrap(
        <CitationPreview
          id="p1"
          preview={{
            title: "BOSS API",
            collectionName: "Engineering",
            collectionColor: "#3633ff",
            updatedAt: "2026-10-14T10:00:00.000Z",
            updatedByName: "Priya <i>Raman</i>",
            quote: "client-credentials grant",
            heading: "Authentication",
            url: "/doc/boss-abc#h-authentication",
            count: 2,
          }}
        />
      )
    );
    const text = host.textContent ?? "";
    expect(text).toContain("§ Authentication");
    expect(text).toContain("Engineering");
    expect(text).toContain("Updated Oct 14, 2026 by Priya <i>Raman</i>");
    expect(text).toContain("Cited 2× in this answer");
    expect(host.querySelector("mark")?.textContent).toBe(
      "client-credentials grant"
    );
    const link = host.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/doc/boss-abc#h-authentication");
    expect(link?.textContent).toContain("Open at section");
    expect(host.querySelector("i")).toBeNull();
  });

  it("links only paths that pass isDocPath and says once for a single citation", () => {
    const render = (url: string) => {
      const el = document.createElement("div");
      el.innerHTML = renderToStaticMarkup(
        wrap(
          <CitationPreview
            id="p1"
            preview={{ title: "T", url, count: 1, quote: "q" }}
          />
        )
      );
      return el;
    };
    expect(render("javascript:alert(1)").querySelector("a")).toBeNull();
    expect(render("/doc/a/../b").querySelector("a")).toBeNull();
    expect(render("https://evil.example/doc/a").querySelector("a")).toBeNull();
    expect(render("/doc/a-abc").textContent).toContain(
      "Cited once in this answer"
    );
  });

  describe("on the marker", () => {
    let host: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;
    const onClick = vi.fn();

    beforeEach(() => {
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      act(() =>
        root.render(
          wrap(
            <AnswerBody
              blocks={[
                {
                  kind: "paragraph",
                  markdown: "Claim.",
                  citations: [cite("/doc/a#h-x", "q")],
                },
              ]}
              previews={
                new Map([
                  [
                    1,
                    {
                      title: "Doc A",
                      collectionName: "Eng",
                      quote: "the quote",
                    },
                  ],
                ])
              }
              onCitationClick={onClick}
            />
          )
        )
      );
    });

    afterEach(() => {
      act(() => root.unmount());
      host.remove();
    });

    const marker = () => host.querySelector("button") as HTMLButtonElement;

    it("is a labelled button with no preview until hover or focus", () => {
      expect(marker().getAttribute("type")).toBe("button");
      expect(marker().getAttribute("aria-label")).toBe("Source 1");
      expect(marker().hasAttribute("aria-describedby")).toBe(false);
      expect(host.querySelector('[role="dialog"]')).toBeNull();
    });

    it("shows the preview on focus, links it by aria-describedby and closes on Escape", () => {
      act(() => {
        marker().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      });
      const tip = host.querySelector('[role="dialog"]');
      expect(tip?.textContent).toContain("the quote");
      expect(marker().getAttribute("aria-describedby")).toBe(tip?.id);
      act(() => {
        marker().dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
      });
      expect(host.querySelector('[role="dialog"]')).toBeNull();
    });

    it("keeps the card while the pointer moves into it, then closes it", () => {
      vi.useFakeTimers();
      try {
        const wrapper = marker().parentElement as HTMLElement;
        act(() => {
          wrapper.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          wrapper.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
        });
        // React derives mouseenter/leave from over/out; the card survives the grace period.
        act(() => {
          vi.advanceTimersByTime(100);
        });
        expect(host.querySelector('[role="dialog"]')).not.toBeNull();
        act(() => {
          vi.advanceTimersByTime(100);
        });
        expect(host.querySelector('[role="dialog"]')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("still activates the source entry on click", () => {
      act(() => marker().click());
      expect(onClick).toHaveBeenCalledWith(1, marker());
    });
  });
});
