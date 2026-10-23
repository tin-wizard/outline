import type * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "styled-components";
import theme from "@shared/styles/theme";
import { AnswerTurn } from "./AnswerTurn";
import type { Turn } from "./model";
import { unavailableCopy } from "./ProblemNotice";

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

let mockIsAdmin = false;
vi.mock("~/hooks/useCurrentUser", () => ({
  default: () => ({ isAdmin: mockIsAdmin }),
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

  it("unavailable offers a search with the same words", () => {
    const host = render({
      ...base,
      blocks: [],
      status: "failed",
      problem: "unavailable",
    });
    const link = host.querySelector("a");
    expect(link?.textContent).toBe("Search instead");
    expect(link?.getAttribute("href")).toBe("/search?q=Q%3F");
  });

  const failedTurn = (extra: Partial<Turn>): Turn => ({
    ...base,
    blocks: [],
    status: "failed",
    problem: "unavailable",
    ...extra,
  });

  it("shows members what is happening, without vendor names", () => {
    mockIsAdmin = false;
    const host = render(
      failedTurn({ cause: "billing", provider: "anthropic" })
    );
    expect(host.textContent).toContain(
      "AI answers are paused because the AI credit has run out."
    );
    expect(host.textContent).not.toContain("Anthropic");
    expect(host.textContent).not.toContain("Plans & Billing");
    expect(host.querySelector("a")?.textContent).toBe("Search instead");
  });

  it("shows admins the provider and how to fix it", () => {
    mockIsAdmin = true;
    const host = render(
      failedTurn({ cause: "billing", provider: "anthropic" })
    );
    mockIsAdmin = false;
    expect(host.textContent).toContain("The Anthropic credit has run out.");
    expect(host.textContent).toContain("Plans & Billing");
    expect(host.querySelector("a")?.textContent).toBe("Search instead");
  });

  it("a turn with no cause keeps the generic copy and the search link", () => {
    for (const admin of [false, true]) {
      mockIsAdmin = admin;
      const host = render(failedTurn({}));
      expect(host.textContent).toContain(
        "AI answers are temporarily unavailable."
      );
      expect(host.querySelector("a")?.getAttribute("href")).toBe(
        "/search?q=Q%3F"
      );
    }
    mockIsAdmin = false;
  });

  it("names an unknown provider as the AI provider", () => {
    mockIsAdmin = true;
    const host = render(failedTurn({ cause: "auth", provider: "mystery" }));
    mockIsAdmin = false;
    expect(host.textContent).toContain("The AI provider API key was rejected.");
  });

  describe("unavailableCopy", () => {
    const t = (key: string, options?: Record<string, unknown>) =>
      key.replace(/\{\{ ?(\w+) ?\}\}/g, (_, name) => String(options?.[name]));
    const generic = { title: "AI answers are temporarily unavailable." };
    const busy = (cause: string) => ({
      title: "The AI service is busy right now.",
      body: `Try again in a minute. (Google Gemini reported: ${cause})`,
    });

    it.each([
      [
        "billing",
        {
          title: "AI answers are paused because the AI credit has run out.",
          body: "An admin has been notified. Search still works for every document.",
        },
        {
          title: "The Google Gemini credit has run out.",
          body: "Add credit in the Google Gemini console (Plans & Billing) and AI answers will resume.",
        },
      ],
      [
        "auth",
        {
          title: "AI answers are temporarily unavailable.",
          body: "An admin has been notified.",
        },
        {
          title: "The Google Gemini API key was rejected.",
          body: "Check the API key in the server settings.",
        },
      ],
      [
        "rate_limit",
        {
          title: "The AI service is busy right now.",
          body: "Try again in a minute.",
        },
        busy("rate limit"),
      ],
      [
        "overloaded",
        {
          title: "The AI service is busy right now.",
          body: "Try again in a minute.",
        },
        busy("overloaded"),
      ],
      [
        "network",
        {
          title: "The AI service is busy right now.",
          body: "Try again in a minute.",
        },
        busy("could not be reached"),
      ],
      [
        "not_configured",
        { title: "AI answers are not set up on this server." },
        {
          title: "No AI provider is configured.",
          body: "Check the AI provider settings and API key on the server.",
        },
      ],
      ["bogus", generic, generic],
      [undefined, generic, generic],
    ])("%s", (cause, member, admin) => {
      expect(unavailableCopy(t, cause, "google", false)).toEqual(member);
      expect(unavailableCopy(t, cause, "google", true)).toEqual(admin);
    });

    it("maps provider display names", () => {
      expect(unavailableCopy(t, "billing", "anthropic", true).title).toBe(
        "The Anthropic credit has run out."
      );
      expect(unavailableCopy(t, "billing", undefined, true).title).toBe(
        "The AI provider credit has run out."
      );
    });
  });

  it("explains compare_needs_two calmly, with no retry", () => {
    const host = render({
      ...base,
      blocks: [],
      status: "failed",
      problem: "compare_needs_two",
    });
    expect(host.textContent).toContain(
      "Compare needs at least two documents in scope."
    );
    expect(host.textContent).not.toContain("Try again");
  });

  it("explains compare_disabled", () => {
    const host = render({
      ...base,
      blocks: [],
      status: "failed",
      problem: "compare_disabled",
    });
    expect(host.textContent).toContain(
      "Compare isn't turned on for this workspace."
    );
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
    expect(host.textContent).not.toContain("Stop");
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

  it("shows the Esc footnote only on the newest turn", () => {
    expect(render(streaming, { isLast: false }).textContent).not.toContain(
      "Only statements that pass verification"
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
