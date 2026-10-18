import type * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "styled-components";
import theme from "@shared/styles/theme";
import { AnswerTurn } from "./AnswerTurn";
import type { Turn } from "./model";

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

const cite = (n: number, url = "/doc/a-abc#h-x", quote?: string) => ({
  n,
  documentId: `d${n}`,
  title: `Doc ${n}`,
  url,
  quote,
});

const base: Turn = {
  id: 1,
  question: "Q?",
  scope: {},
  status: "done",
  sources: [{ n: 1, documentId: "d1", title: "Doc 1", url: "/doc/a-abc" }],
  blocks: [
    {
      index: 0,
      kind: "paragraph",
      markdown: "Permanent employees get 16 weeks.",
      citations: [cite(1)],
    },
  ],
};

const gap = (markdown: string, index = 1): Turn["blocks"][number] => ({
  index,
  kind: "paragraph",
  markdown,
  citations: [],
});

const wrap = (node: React.ReactNode) => (
  <ThemeProvider theme={theme}>
    <MemoryRouter>{node}</MemoryRouter>
  </ThemeProvider>
);

function render(
  turn: Turn,
  props: Partial<React.ComponentProps<typeof AnswerTurn>> = {}
) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    wrap(
      <AnswerTurn
        turn={turn}
        isLast
        scopeLabels={[]}
        onStop={() => {}}
        onRetry={() => {}}
        {...props}
      />
    )
  );
  return host;
}

describe("error cards", () => {
  it("tells the budget reset day in the user's locale and offers search", () => {
    const host = render({
      ...base,
      blocks: [],
      status: "failed",
      problem: "budget",
      resetsAt: "2026-11-01T00:00:00.000Z",
    });
    const text = host.textContent ?? "";
    expect(text).toContain("Your workspace has used this month's AI answers.");
    expect(text).toContain("The limit resets on Nov 1, 2026.");
    expect(text).toContain("Search still works for every document.");
    expect(host.querySelector("a")?.getAttribute("href")).toBe(
      "/search?q=Q%3F"
    );
    expect(host.querySelector("a")?.textContent).toBe("Search instead");
  });

  it("falls back to calm copy without a reset time", () => {
    const host = render({
      ...base,
      blocks: [],
      status: "failed",
      problem: "budget",
    });
    expect(host.textContent).toContain("Ask an admin or try again later.");
    expect(host.textContent).not.toContain("resets on");
  });

  it("shows the quota reset time and no retry", () => {
    const host = render({
      ...base,
      blocks: [],
      status: "failed",
      problem: "quota",
      resetsAt: "2026-10-19T00:00:00.000Z",
    });
    expect(host.textContent).toContain("You've reached your daily AI limit.");
    expect(host.textContent).toContain("It resets on Oct ");
    expect(host.textContent).not.toContain("Try again");
  });

  it("says a scope is unavailable without naming it", () => {
    const host = render(
      { ...base, blocks: [], status: "failed", problem: "scope_forbidden" },
      { scopeLabels: ["Board Minutes"], onRetryUnscoped: () => {} }
    );
    const text = host.textContent ?? "";
    expect(text).toContain("That scope isn't available to you.");
    expect(text).toContain("Ask again without a scope");
    expect(text).not.toContain("Board Minutes");
  });

  it.each([
    ["timeout", "This took too long.", true],
    ["network", "Couldn't reach the server.", true],
    ["error", "Something went wrong while answering.", true],
    ["unavailable", "AI answers are temporarily unavailable.", true],
    ["forbidden", "AI answers aren't available to your account.", false],
  ] as const)("%s: %s (retry: %s)", (problem, title, retry) => {
    const host = render({ ...base, blocks: [], status: "failed", problem });
    expect(host.textContent).toContain(title);
    expect(host.textContent?.includes("Try again")).toBe(retry);
  });

  it("never claims nothing was charged", () => {
    const host = render({
      ...base,
      blocks: [],
      status: "failed",
      problem: "network",
    });
    expect(host.textContent).not.toMatch(/charged/i);
  });

  it("offers retry only on the newest turn", () => {
    const host = render(
      { ...base, blocks: [], status: "failed", problem: "timeout" },
      { isLast: false }
    );
    expect(host.textContent).not.toContain("Try again");
  });

  it("wires Try again and Ask again without a scope", () => {
    const onRetry = vi.fn();
    const onRetryUnscoped = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const failed: Turn = {
      ...base,
      blocks: [],
      status: "failed",
      problem: "scope_forbidden",
    };
    act(() =>
      root.render(
        wrap(
          <AnswerTurn
            turn={failed}
            isLast
            scopeLabels={[]}
            onStop={() => {}}
            onRetry={onRetry}
            onRetryUnscoped={onRetryUnscoped}
          />
        )
      )
    );
    const button = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("without a scope")
    );
    act(() => button?.click());
    expect(onRetryUnscoped).toHaveBeenCalledWith(failed);
    act(() => root.unmount());
    host.remove();
  });
});

describe("gap statements", () => {
  it("renders a gap sentence as a calm note card with actions, not as prose", () => {
    const host = render({
      ...base,
      blocks: [
        ...base.blocks,
        gap("The documents do not cover parental leave for contractors."),
      ],
    });
    const note = host.querySelector('[role="note"]');
    expect(note?.textContent).toContain(
      "The documents do not cover parental leave for contractors."
    );
    // the cited paragraph stays normal prose, outside the card
    expect(note?.textContent).not.toContain("Permanent employees");
    const links = [...(note?.querySelectorAll("a") ?? [])];
    expect(links.map((a) => a.textContent)).toEqual([
      "Open Doc 1",
      "Search instead",
    ]);
    expect(links[0].getAttribute("href")).toBe("/doc/a-abc#h-x");
  });

  it("keeps hostile text in the gap sentence literal", () => {
    const evil =
      "The documents do not cover <img src=x onerror=alert(1)> [x](javascript:alert(1)) www.evil.example";
    const host = render({ ...base, blocks: [...base.blocks, gap(evil)] });
    expect(host.querySelector("img, script")).toBeNull();
    expect(host.querySelector('[role="note"]')?.textContent).toContain(evil);
    expect(
      [...host.querySelectorAll("a")].map((a) => a.getAttribute("href"))
    ).not.toContain("javascript:alert(1)");
  });

  it("puts only the first gap's actions on the answer", () => {
    const host = render({
      ...base,
      blocks: [
        ...base.blocks,
        gap("The documents do not cover A.", 1),
        gap("The documents do not cover B.", 2),
      ],
    });
    const notes = [...host.querySelectorAll('[role="note"]')];
    expect(notes).toHaveLength(2);
    expect(notes[0].querySelectorAll("a").length).toBeGreaterThan(0);
    expect(notes[1].querySelectorAll("a")).toHaveLength(0);
  });

  it("does not treat a cited or look-alike paragraph as a gap", () => {
    const host = render({
      ...base,
      blocks: [
        {
          ...gap("The documents do not cover X.", 1),
          citations: [cite(1)],
        },
        gap("Documents are useful.", 2),
      ],
    });
    expect(host.querySelector('[role="note"]')).toBeNull();
  });

  it("shows a fully not-covered answer as one card with the scope searched", () => {
    const host = render(
      {
        ...base,
        sources: [],
        blocks: [gap("The documents do not cover this.", 0)],
      },
      { scopeLabels: ["Eng"] }
    );
    const notes = host.querySelectorAll('[role="note"]');
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toContain("Not covered by your documents");
    expect(notes[0].textContent).toContain("The documents do not cover this.");
    expect(notes[0].textContent).toContain("Searched in: Eng.");
    expect(notes[0].textContent).toContain("Try rephrasing");
    expect(host.textContent).not.toContain("Verified");
  });

  it("names a resumed turn's stored scope, or says it was a scope while hiding names", () => {
    const stored = (collections: { id: string; name?: string }[]): Turn => ({
      ...base,
      status: "failed",
      problem: "no_answer",
      blocks: [],
      storedScope: { collections, documents: [] },
    });
    const id = "0b8c7a4e-5b2f-4f5e-9d3a-1f2e3d4c5b6a";
    expect(render(stored([{ id, name: "Engineering" }])).textContent).toContain(
      "Searched in: Engineering."
    );
    expect(render(stored([{ id }])).textContent).toContain(
      "Searched in: the scope you chose."
    );
    expect(
      render({ ...base, status: "failed", problem: "no_answer", blocks: [] })
        .textContent
    ).toContain("Searched in: all documents.");
  });
});

describe("streaming state", () => {
  const streaming: Turn = {
    ...base,
    status: "generating",
    sources: [
      { n: 1, documentId: "d1", title: "Doc 1", url: "/doc/a-abc" },
      { n: 2, documentId: "d2", title: "Doc 2", url: "/doc/b-abc" },
    ],
  };

  it("shows the finished steps, the current one with a status role, a caret and a footnote", () => {
    const host = render(streaming, { scopeLabels: ["People"] });
    const items = [...host.querySelectorAll("ol > li")].map(
      (li) => li.textContent
    );
    expect(items).toEqual([
      "Searched your documents in People",
      "Read 2 documents",
      "Writing and checking each statement",
    ]);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Writing and checking each statement"
    );
    expect(host.querySelector("[aria-live]")?.getAttribute("aria-busy")).toBe(
      "true"
    );
    expect(host.textContent).toContain(
      "Only statements that pass verification are shown."
    );
    expect(host.querySelector("kbd")?.textContent).toBe("Esc");
    expect(host.textContent).toContain("Stop");
  });

  it("is searching before any source arrives, with no pill or actions", () => {
    const host = render({
      ...base,
      status: "searching",
      sources: null,
      blocks: [],
    });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Searching your documents"
    );
    expect(host.querySelectorAll("ol > li")).toHaveLength(1);
    expect(host.textContent).not.toContain("Verified");
    expect(host.querySelector('[aria-label="Copy answer"]')).toBeNull();
  });

  it("offers Stop only on the newest turn", () => {
    expect(render(streaming, { isLast: false }).textContent).not.toContain(
      "Stop"
    );
  });
});

describe("action row", () => {
  const UUID = "0b8c7a4e-5b2f-4f5e-9d3a-1f2e3d4c5b6a";
  const rateable: Turn = { ...base, usageId: UUID, timings: { totalMs: 6234 } };
  const noop = () => {};

  it("shows how long the answer took", () => {
    expect(render(rateable).textContent).toContain("Answered in 6.2 s");
    expect(
      render({ ...rateable, timings: undefined }).textContent
    ).not.toContain("Answered in");
  });

  it("offers copy, helpful, not helpful and report only where they work", () => {
    const labels = (host: HTMLElement) =>
      [...host.querySelectorAll("button[aria-label]:not([data-citation])")].map(
        (b) => b.getAttribute("aria-label")
      );
    expect(
      labels(render(rateable, { onRate: noop, onReport: async () => true }))
    ).toEqual(["Copy answer", "Helpful", "Not helpful", "Report inaccurate"]);
    // no usage row: nothing to rate or report
    expect(
      labels(
        render(
          { ...rateable, usageId: null },
          { onRate: noop, onReport: async () => true }
        )
      )
    ).toEqual(["Copy answer"]);
    // no report handler: no flag
    expect(labels(render(rateable, { onRate: noop }))).toEqual([
      "Copy answer",
      "Helpful",
      "Not helpful",
    ]);
  });

  it("marks the current rating as pressed", () => {
    const host = render(
      {
        ...rateable,
        feedback: { rating: "down", previous: null, pending: false },
      },
      { onRate: noop }
    );
    expect(
      host
        .querySelector('[aria-label="Not helpful"]')
        ?.getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      host.querySelector('[aria-label="Helpful"]')?.getAttribute("aria-pressed")
    ).toBe("false");
  });
});
