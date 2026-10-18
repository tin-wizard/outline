import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "styled-components";
import theme from "@shared/styles/theme";
import type { StoredTurn } from "~/models/AIConversation";
import { AnswerTurn } from "./AnswerTurn";
import { chatReducer, initialChatState } from "./model";

vi.mock("~/components/Button", () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

const stored: StoredTurn = {
  id: "t",
  position: 0,
  question: "Q?",
  outcome: "answered",
  usageId: null,
  createdAt: "2026-10-18T10:00:00.000Z",
  sources: [
    { n: 1, documentId: "d", title: "Doc", url: "javascript:alert(1)" },
  ],
  blocks: [
    {
      kind: "paragraph",
      markdown: "Before [1].",
      citations: [
        { n: 1, documentId: "d", title: "Doc", url: "javascript:alert(1)" },
      ],
    },
    { kind: "paragraph", hidden: true },
    { kind: "paragraph", markdown: "After.", citations: [] },
  ],
  hasHiddenBlocks: true,
};

describe("a resumed answer", () => {
  const html = () => {
    const [turn] = chatReducer(initialChatState, {
      type: "hydrate",
      conversationId: "c",
      turns: [stored],
    }).turns;
    return renderToStaticMarkup(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <AnswerTurn
            turn={turn}
            isLast
            scopeLabels={[]}
            onStop={() => {}}
            onRetry={() => {}}
          />
        </MemoryRouter>
      </ThemeProvider>
    );
  };

  it("shows a calm note, in position, where a block is withheld", () => {
    const out = html();
    const note = out.indexOf("no longer available");
    expect(out.indexOf("Before")).toBeLessThan(note);
    expect(note).toBeLessThan(out.indexOf("After."));
    expect(out).toContain('role="note"');
  });

  it("never links an unsafe stored url", () => {
    expect(html()).not.toContain("javascript:");
  });
});
