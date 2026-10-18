import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "styled-components";
import theme from "@shared/styles/theme";
import { AnswerTurn } from "./AnswerTurn";
import { SourceCard } from "./SourceCard";
import { compareLetters, isCompare } from "./compare";
import type { Turn } from "./model";

const cite = (n: number, title: string) => ({
  n,
  documentId: `d${n}`,
  title,
  url: `/doc/t-${n}#h-limit`,
});

const turn = (patch: Partial<Turn> = {}): Turn => ({
  id: 1,
  question: "What changed?",
  scope: { mode: "compare" },
  status: "done",
  sources: [
    {
      n: 1,
      documentId: "d1",
      title: "Policy v3",
      url: "/doc/t-1",
      collectionName: "Finance",
      updatedAt: "2025-03-02T00:00:00.000Z",
    },
    {
      n: 2,
      documentId: "d2",
      title: "<b>Policy v4</b>",
      url: "/doc/t-2",
      collectionName: "Finance",
      updatedAt: "2026-09-08T00:00:00.000Z",
    },
  ],
  // Columns in the opposite order of retrieval.
  blocks: [
    {
      index: 0,
      kind: "tableHeader",
      markdown: "| Aspect | \\<b\\>Policy v4\\</b\\> | Policy v3 |",
      citations: [],
    },
    {
      index: 1,
      kind: "tableRow",
      markdown: "| Limit | 120 | 100 |",
      citations: [cite(2, "<b>Policy v4</b>"), cite(1, "Policy v3")],
    },
  ],
  ...patch,
});

function render(t: Turn): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AnswerTurn turn={t} isLast scopeLabels={[]} onRetry={() => {}} />
      </MemoryRouter>
    </ThemeProvider>
  );
  return host;
}

describe("compareLetters", () => {
  it("letters sources by the order of the table columns", () => {
    expect(Object.fromEntries(compareLetters(turn()))).toEqual({
      1: "B",
      2: "A",
    });
  });

  it("falls back to retrieval order when the header names nothing", () => {
    const t = turn({ blocks: [] });
    expect([...compareLetters(t)]).toEqual([
      [1, "A"],
      [2, "B"],
    ]);
  });

  it("only compare turns are compare", () => {
    expect(isCompare(turn())).toBe(true);
    expect(isCompare(turn({ scope: {} }))).toBe(false);
  });
});

describe("compare answers", () => {
  it("shows a card per document with tag, title, collection and date, as text", () => {
    const host = render(turn());
    const cards = [...host.querySelectorAll("ul[aria-label] > li")];
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("A");
    expect(cards[0].textContent).toContain("<b>Policy v4</b>");
    expect(cards[0].textContent).toContain("Finance");
    expect(cards[0].textContent).toContain("Updated Sep 8, 2026");
    expect(cards[1].textContent).toContain("Policy v3");
    expect(host.querySelector("ul[aria-label] b > b")).toBeNull();
  });

  it("uses letters on the citation chips", () => {
    const chips = [...render(turn()).querySelectorAll("[data-citation]")];
    expect(chips.map((c) => c.getAttribute("aria-label")).sort()).toEqual([
      "Source A",
      "Source B",
    ]);
    expect(chips.map((c) => c.textContent).sort()).toEqual(["A", "B"]);
  });

  it("shows no cards before the table header, or outside compare mode", () => {
    expect(
      render(turn({ blocks: [] })).querySelector("ul[aria-label]")
    ).toBeNull();
    const plain = render(turn({ scope: {} }));
    expect(plain.querySelector("ul[aria-label]")).toBeNull();
    expect(
      [...plain.querySelectorAll("[data-citation]")].map((c) => c.textContent)
    ).toEqual(["1", "2"]);
  });

  it("keeps numbers on the source card and adds the letter tag", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <SourceCard
            id="s"
            letter="B"
            source={{ n: 3, title: "Doc", sections: [], count: 1 }}
          />
        </MemoryRouter>
      </ThemeProvider>
    );
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.textContent).toContain("3");
    expect(host.textContent).toContain("B");
  });
});
