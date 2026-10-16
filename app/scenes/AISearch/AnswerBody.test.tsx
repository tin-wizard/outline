import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "styled-components";
import theme from "@shared/styles/theme";
import type { AskCitation, AskSource } from "~/utils/streamFetch";
import { AnswerBody } from "./AnswerBody";
import { AnswerTurn } from "./AnswerTurn";
import type { BlockInput } from "./markdown";
import { groupBlocks, parseInline } from "./markdown";
import type { Turn } from "./model";

// The real Button needs the action context provider.
vi.mock("~/components/Button", () => ({
  default: ({
    children,
    onClick,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

const cite = (n: number, url = "/doc/a-abc#h-intro"): AskCitation => ({
  n,
  documentId: "d",
  title: "Doc A",
  url,
});

const para = (markdown: string, citations: AskCitation[] = []): BlockInput => ({
  kind: "paragraph",
  markdown,
  citations,
});

function html(blocks: BlockInput[]): string {
  return renderToStaticMarkup(<AnswerBody blocks={blocks} />);
}

function dom(blocks: BlockInput[]): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html(blocks);
  return host;
}

describe("AnswerBody with hostile input", () => {
  const attacks = [
    "\\[x\\]\\(javascript:alert\\(1\\)\\)",
    "[x](javascript:alert(1))",
    "<img src=x onerror=alert(1)>",
    "\\<img src=x onerror=alert\\(1\\)\\>",
    "<script>alert(1)</script>",
    "![img](https://evil.example/a.png)",
    "visit example.com or https://evil.example/path and www.evil.example",
    "mail me at a@b.example",
    '<a href="javascript:alert(1)">x</a>',
    "<iframe src=//evil></iframe>",
    "<svg onload=alert(1)>",
  ];

  it.each(attacks)("renders %s as literal text only", (attack) => {
    for (const kind of ["paragraph", "heading", "listItem"] as const) {
      const prefix =
        kind === "heading" ? "# " : kind === "listItem" ? "- " : "";
      const root = dom([{ kind, markdown: prefix + attack, citations: [] }]);
      expect(
        root.querySelector("a, img, script, iframe, svg, form")
      ).toBeNull();
      for (const el of root.querySelectorAll("*")) {
        for (const name of el.getAttributeNames()) {
          expect(name.startsWith("on")).toBe(false);
          expect(["href", "src"]).not.toContain(name);
        }
      }
    }
  });

  it("shows the unescaped text literally", () => {
    expect(
      dom([para("\\[x\\]\\(javascript:alert\\(1\\)\\)")]).textContent
    ).toBe("[x](javascript:alert(1))");
    expect(dom([para("<img src=x onerror=alert(1)>")]).textContent).toBe(
      "<img src=x onerror=alert(1)>"
    );
    expect(dom([para("<script>alert(1)</script>")]).textContent).toBe(
      "<script>alert(1)</script>"
    );
    expect(
      dom([para("see example.com and https://x.example")]).textContent
    ).toBe("see example.com and https://x.example");
  });

  it("keeps hostile text inside code and tables inert", () => {
    const root = dom([
      {
        kind: "code",
        markdown: "```html\n<img src=x onerror=alert(1)>\n```",
        citations: [],
      },
      {
        kind: "tableHeader",
        markdown: "| a | b |\n| --- | --- |",
        citations: [],
      },
      {
        kind: "tableRow",
        markdown: "| <img src=x onerror=alert\\(1\\)> | [l](javascript:x) |",
        citations: [],
      },
    ]);
    expect(root.querySelector("a, img, script")).toBeNull();
    expect(root.querySelector("pre code")?.textContent).toBe(
      "<img src=x onerror=alert(1)>"
    );
    expect(root.querySelectorAll("td")[0].textContent).toBe(
      "<img src=x onerror=alert(1)>"
    );
  });

  it("never emits a dangerouslySetInnerHTML-style raw string", () => {
    expect(html([para("<b>bold</b>")])).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("renders emphasis and inline code but not pseudo-markup", () => {
    const root = dom([para("**bold** and *it* and `a<b` and snake_case_name")]);
    expect(root.querySelector("strong")?.textContent).toBe("bold");
    expect(root.querySelector("em")?.textContent).toBe("it");
    expect(root.querySelector("code")?.textContent).toBe("a<b");
    expect(root.textContent).toContain("snake_case_name");
  });

  it("treats unmatched markers as text", () => {
    expect(parseInline("2 * 3 * 4 and **open")).toEqual([
      { type: "text", value: "2 * 3 * 4 and **open" },
    ]);
  });
});

describe("block grouping", () => {
  it("joins table rows to their header", () => {
    const groups = groupBlocks([
      {
        kind: "tableHeader",
        markdown: "| A | B |\n| --- | --- |",
        citations: [],
      },
      { kind: "tableRow", markdown: "| 1 | 2 |", citations: [cite(1)] },
      { kind: "tableRow", markdown: "| 3 | 4 |", citations: [] },
    ]);
    expect(groups).toHaveLength(1);
    const root = dom([
      {
        kind: "tableHeader",
        markdown: "| A | B |\n| --- | --- |",
        citations: [],
      },
      { kind: "tableRow", markdown: "| 1 | 2 |", citations: [cite(1)] },
      { kind: "tableRow", markdown: "| 3 | 4 |", citations: [] },
    ]);
    expect([...root.querySelectorAll("th")].map((e) => e.textContent)).toEqual([
      "A",
      "B",
    ]);
    expect(root.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(root.querySelectorAll("tbody tr")[0].textContent).toContain("21");
  });

  it("splits cells on unescaped pipes only", () => {
    const root = dom([
      {
        kind: "tableHeader",
        markdown: "| a \\| b | c |\n| --- | --- |",
        citations: [],
      },
    ]);
    expect([...root.querySelectorAll("th")].map((e) => e.textContent)).toEqual([
      "a | b",
      "c",
    ]);
  });

  it("builds one list from consecutive items and splits on kind change", () => {
    const item = (markdown: string): BlockInput => ({
      kind: "listItem",
      markdown,
      citations: [],
    });
    const root = dom([
      item("- one"),
      item("- two"),
      item("3. three"),
      item("4. four"),
    ]);
    expect(root.querySelectorAll("ul > li")).toHaveLength(2);
    expect(root.querySelectorAll("ol > li")).toHaveLength(2);
    expect(root.querySelector("ol")?.getAttribute("start")).toBe("3");
  });

  it("shows a headerless table row as text", () => {
    const root = dom([
      { kind: "tableRow", markdown: "| 1 | 2 |", citations: [] },
    ]);
    expect(root.querySelector("table")).toBeNull();
    expect(root.textContent).toBe("1 | 2");
  });

  it("maps heading levels below the page and answer headings", () => {
    const root = dom([{ kind: "heading", markdown: "## Part", citations: [] }]);
    expect(root.querySelector("h4")?.textContent).toBe("Part");
  });
});

describe("citations", () => {
  it("renders numbered, labelled marker buttons (no links)", () => {
    const root = dom([para("Claim.", [cite(2), cite(1), cite(2)])]);
    const buttons = [...root.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["1", "2"]);
    expect(buttons[0].getAttribute("type")).toBe("button");
    expect(buttons[0].getAttribute("aria-label")).toBeTruthy();
    expect(root.querySelector("a")).toBeNull();
  });
});

describe("AnswerTurn sources", () => {
  const sources: AskSource[] = [
    {
      n: 1,
      documentId: "d",
      title: "Doc A",
      url: "/doc/a-abc",
      collectionName: "Eng",
    },
  ];
  const turn = (patch: Partial<Turn>): Turn => ({
    id: 1,
    question: "Q?",
    scope: {},
    status: "done",
    sources,
    blocks: [
      { index: 0, kind: "paragraph", markdown: "Claim.", citations: [cite(1)] },
    ],
    ...patch,
  });
  const render = (t: Turn) => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <AnswerTurn
            turn={t}
            isLast
            scopeLabels={[]}
            onStop={() => {}}
            onRetry={() => {}}
          />
        </MemoryRouter>
      </ThemeProvider>
    );
    return host;
  };

  it("links only server-provided doc paths and shows collection and title as text", () => {
    const host = render(turn({}));
    const anchors = [...host.querySelectorAll("a")];
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute("href")).toBe("/doc/a-abc#h-intro");
    expect(anchors[0].textContent).toBe("Doc A");
    expect(host.textContent).toContain("Eng");
  });

  it("does not link unsafe urls or inject hostile titles", () => {
    const host = render(
      turn({
        blocks: [
          {
            index: 0,
            kind: "paragraph",
            markdown: "x",
            citations: [
              {
                ...cite(1, "javascript:alert(1)"),
                title: "<img src=x onerror=alert(1)>",
              },
            ],
          },
        ],
      })
    );
    expect(host.querySelector("a, img")).toBeNull();
    expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("labels partial answers and shows the reason", () => {
    const host = render(turn({ status: "failed", problem: "unverified" }));
    expect(host.textContent).toContain("Partial answer, not fully verified");
    expect(host.textContent).toContain("Couldn't fully verify this answer");
    expect(host.textContent).toContain("Claim.");
  });

  it("shows no results with the scope searched", () => {
    const host = renderToStaticMarkup(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <AnswerTurn
            turn={turn({
              status: "failed",
              problem: "no_answer",
              blocks: [],
              sources: [],
            })}
            isLast
            scopeLabels={["Eng"]}
            onStop={() => {}}
            onRetry={() => {}}
          />
        </MemoryRouter>
      </ThemeProvider>
    );
    expect(host).toContain("No relevant documents found");
    expect(host).toContain("Searched in: Eng.");
  });

  it("marks the answer region as polite and busy while streaming", () => {
    const host = render(turn({ status: "generating" }));
    const region = host.querySelector("[aria-live]");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.getAttribute("aria-busy")).toBe("true");
    expect(host.textContent).toContain("Writing answer…");
    expect(host.textContent).toContain("Stop");
  });

  it("puts phase text in its own status outside the aria-busy region", () => {
    const host = render(turn({ status: "searching", blocks: [] }));
    const status = host.querySelector('[role="status"]');
    expect(status?.textContent).toBe("Searching your documents…");
    expect(status?.closest("[aria-live]")).toBeNull();
    expect(host.querySelector("[aria-live] [role=status]")).toBeNull();
  });

  it("shows the Retry-After wait and a retry button for rate limiting", () => {
    const host = render(
      turn({ status: "failed", problem: "rateLimited", retryAfter: 42 })
    );
    expect(host.textContent).toContain(
      "Too many requests, try again in 42 seconds."
    );
    expect(host.textContent).toContain("Try again");
    const plain = render(turn({ status: "failed", problem: "rateLimited" }));
    expect(plain.textContent).toContain(
      "Too many requests, try again in a minute."
    );
  });

  it("links every distinct cited section of a source", () => {
    const host = render(
      turn({
        blocks: [
          {
            index: 0,
            kind: "paragraph",
            markdown: "a",
            citations: [cite(1, "/doc/a-abc#h-one")],
          },
          {
            index: 1,
            kind: "paragraph",
            markdown: "b",
            citations: [cite(1, "/doc/a-abc#h-two")],
          },
        ],
      })
    );
    expect(
      [...host.querySelectorAll("a")].map((a) => a.getAttribute("href"))
    ).toEqual(["/doc/a-abc#h-one", "/doc/a-abc#h-two"]);
  });

  it("shows a retrieved-sources count while streaming, as one translated string", () => {
    const host = render(turn({ status: "generating", blocks: [] }));
    expect(host.querySelector("summary")?.textContent).toContain("Sources");
    expect(host.querySelector("summary")?.textContent).toContain("1");
  });

  describe("feedback buttons", () => {
    const UUID = "0b8c7a4e-5b2f-4f5e-9d3a-1f2e3d4c5b6a";
    const withRate = (t: Turn) => {
      const host = document.createElement("div");
      host.innerHTML = renderToStaticMarkup(
        <ThemeProvider theme={theme}>
          <MemoryRouter>
            <AnswerTurn
              turn={t}
              isLast
              scopeLabels={[]}
              onStop={() => {}}
              onRetry={() => {}}
              onRate={() => {}}
            />
          </MemoryRouter>
        </ThemeProvider>
      );
      return host;
    };
    const buttons = (h: HTMLElement) =>
      [...h.querySelectorAll("button[aria-pressed]")] as HTMLButtonElement[];

    it("shows two labelled toggle buttons on a finished, recorded answer", () => {
      const host = withRate(turn({ usageId: UUID }));
      const b = buttons(host);
      expect(b.map((x) => x.getAttribute("aria-label"))).toEqual([
        "Helpful",
        "Not helpful",
      ]);
      expect(b.map((x) => x.getAttribute("aria-pressed"))).toEqual([
        "false",
        "false",
      ]);
      expect(host.querySelector("[aria-live] button[aria-pressed]")).toBeNull();
    });

    it("reflects the rating, pending and the thanks status", () => {
      const host = withRate(
        turn({
          usageId: UUID,
          feedback: { rating: "down", previous: null, pending: true },
        })
      );
      const b = buttons(host);
      expect(b.map((x) => x.getAttribute("aria-pressed"))).toEqual([
        "false",
        "true",
      ]);
      expect(b.every((x) => x.disabled)).toBe(true);
      const saved = withRate(
        turn({
          usageId: UUID,
          feedback: {
            rating: "up",
            previous: null,
            pending: false,
            saved: true,
          },
        })
      );
      const status = [...saved.querySelectorAll('[role="status"]')].pop();
      expect(status?.textContent).toBe("Thanks for the feedback");
      expect(status?.closest("[aria-live]")).toBeNull();
    });

    it("shows an inline error and rate-limit message", () => {
      const failed = withRate(
        turn({
          usageId: UUID,
          feedback: {
            rating: null,
            previous: null,
            pending: false,
            error: "failed",
          },
        })
      );
      expect(failed.textContent).toContain("Couldn't save your feedback");
      const limited = withRate(
        turn({
          usageId: UUID,
          feedback: {
            rating: null,
            previous: null,
            pending: false,
            error: "rateLimited",
          },
        })
      );
      expect(limited.textContent).toContain("Too many requests");
    });

    it.each([
      ["no usageId", { usageId: null }],
      ["usageId undefined", {}],
      ["streaming", { usageId: UUID, status: "generating" as const }],
      [
        "failed",
        {
          usageId: UUID,
          status: "failed" as const,
          problem: "unverified" as const,
        },
      ],
      ["stopped", { usageId: UUID, status: "stopped" as const }],
      [
        "refused",
        {
          usageId: UUID,
          feedback: {
            rating: null,
            previous: null,
            pending: false,
            hidden: true,
          },
        },
      ],
    ])("renders no feedback UI when %s", (_n, patch) => {
      expect(buttons(withRate(turn(patch)))).toHaveLength(0);
    });
  });
});
