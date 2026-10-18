import { conversationDraft, MAX_DRAFT_TITLE, turnDraft } from "./draft";
import type { Turn } from "./model";

const turn = (patch: Partial<Turn> = {}): Turn => ({
  id: 1,
  question: "How do we onboard?",
  scope: {},
  status: "done",
  sources: [],
  blocks: [
    {
      index: 0,
      kind: "paragraph",
      markdown: "Meet your buddy [1].",
      citations: [
        {
          n: 1,
          documentId: "d1",
          title: "Onboarding",
          url: "/doc/onb-abc#h-day-one",
        },
      ],
    },
  ],
  ...patch,
});

const ORIGIN = "https://wiki.example.com";

describe("turnDraft", () => {
  it("uses the question as title and the released blocks plus sources as text", () => {
    const draft = turnDraft(turn(), ORIGIN);
    expect(draft?.title).toBe("How do we onboard?");
    expect(draft?.text).toContain("Meet your buddy [1].");
    expect(draft?.text).toContain(
      "1. [Onboarding](https://wiki.example.com/doc/onb-abc#h-day-one)"
    );
    // The question is the title, not repeated as a quote.
    expect(draft?.text).not.toContain("> How do we onboard");
  });

  it("limits the title to 100 characters and flattens whitespace", () => {
    const draft = turnDraft(
      turn({ question: `  ${"word ".repeat(40)}\n next ` }),
      ORIGIN
    );
    expect(draft?.title.length).toBeLessThanOrEqual(MAX_DRAFT_TITLE);
    expect(draft?.title).not.toMatch(/\s{2}|\n/);
    expect(draft?.title.endsWith("…")).toBe(true);
  });

  it("saves nothing for turns without a released answer", () => {
    expect(turnDraft(turn({ blocks: [] }), ORIGIN)).toBeUndefined();
    expect(turnDraft(turn({ status: "failed" }), ORIGIN)).toBeUndefined();
    expect(turnDraft(turn({ status: "stopped" }), ORIGIN)).toBeUndefined();
  });

  it("never links an unsafe source path", () => {
    const draft = turnDraft(
      turn({
        blocks: [
          {
            index: 0,
            kind: "paragraph",
            markdown: "Text [1].",
            citations: [
              {
                n: 1,
                documentId: "d1",
                title: "Evil",
                url: "https://evil.example/x",
              },
            ],
          },
        ],
      }),
      ORIGIN
    );
    expect(draft?.text).not.toContain("evil.example");
    expect(draft?.text).not.toContain("](");
  });

  it("keeps only text the server released: a hidden block becomes a plain note", () => {
    const draft = turnDraft(turn({ hiddenBlocks: [1] }), ORIGIN);
    expect(draft?.text).toContain("no longer available");
  });
});

describe("conversationDraft", () => {
  it("quotes each answered question, skips unanswered turns and uses the chat title", () => {
    const draft = conversationDraft(
      [
        turn(),
        turn({ id: 2, question: "Failed?", status: "failed", blocks: [] }),
        turn({ id: 3, question: "Second?" }),
      ],
      "Onboarding chat",
      ORIGIN
    );
    expect(draft?.title).toBe("Onboarding chat");
    expect(draft?.text).toContain("> How do we onboard?");
    expect(draft?.text).toContain("> Second?");
    expect(draft?.text).not.toContain("Failed?");
    expect(draft?.text).toContain("---");
  });

  it("returns nothing without an answered turn", () => {
    expect(
      conversationDraft([turn({ blocks: [] })], "x", ORIGIN)
    ).toBeUndefined();
  });
});
