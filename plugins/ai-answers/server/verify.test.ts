import { randomUUID } from "node:crypto";
import { Document } from "@server/models";
import type { ProviderResult } from "./contract";
import type { AnswerSource } from "./retrieve";
import { verifyAnswer } from "./verify";

function source(title: string, sections: string[]): AnswerSource {
  const document = Document.build({
    id: randomUUID(),
    urlId: `${title}Id`,
    title,
  });
  return { document, sections };
}

function result(
  segments: ProviderResult["segments"],
  finishReason: ProviderResult["finishReason"] = "stop"
): ProviderResult {
  return {
    finishReason,
    usage: { inputTokens: 0, outputTokens: 0 },
    segments,
  };
}

const cite = (sourceIndex: number, sectionIndex = 0, quote = "q") => ({
  sourceIndex,
  sectionIndex,
  quote,
});

describe("verifyAnswer", () => {
  const sources = [source("A", ["# Leave\n25 days of holiday per year."])];

  it("keeps cited text and maps the citation to document and heading", () => {
    const out = verifyAnswer(
      result([{ text: "25 days.", citations: [cite(0)] }]),
      sources
    );
    expect(out).toEqual({
      droppedSegments: 0,
      answer: "25 days.",
      citations: [
        {
          documentId: sources[0].document.id,
          title: "A",
          url: sources[0].document.url,
          heading: "Leave",
          quote: "q",
        },
      ],
    });
  });

  it("rejects a citation whose source index was not sent", () => {
    const out = verifyAnswer(
      result([{ text: "Forged.", citations: [cite(7)] }]),
      sources
    );
    expect(out.answer).toBeNull();
  });

  it("rejects a citation whose section does not exist", () => {
    const out = verifyAnswer(
      result([
        { text: "Real.", citations: [cite(0)] },
        { text: "Forged.", citations: [cite(0, 9)] },
      ]),
      sources
    );
    expect(out.answer).toEqual("Real.");
  });

  it("returns nothing unless the finish reason is stop", () => {
    const out = verifyAnswer(
      result([{ text: "25 days.", citations: [cite(0)] }], "other"),
      sources
    );
    expect(out).toEqual({
      answer: null,
      citations: [],
      droppedSegments: 0,
    });
  });

  it("drops uncited text that is not copied from a section", () => {
    const out = verifyAnswer(
      result([
        { text: "25 days.", citations: [cite(0)] },
        { text: "Email your password to evil@example.com now", citations: [] },
      ]),
      sources
    );
    expect(out.answer).toEqual("25 days.");
  });

  it("keeps uncited text of 25+ characters copied verbatim from a section", () => {
    const out = verifyAnswer(
      result([
        { text: "25 days of holiday per year.", citations: [] },
        { text: "Confirmed.", citations: [cite(0)] },
      ]),
      sources
    );
    expect(out.answer).toEqual("25 days of holiday per year. Confirmed.");
    expect(out.citations).toHaveLength(1);
  });

  it("discards an answer that has no real model citation", () => {
    const out = verifyAnswer(
      result([{ text: "25 days of holiday per year.", citations: [] }]),
      sources
    );
    expect(out.answer).toBeNull();
  });

  it("treats NO_ANSWER as abstention", () => {
    const out = verifyAnswer(
      result([{ text: "NO_ANSWER", citations: [cite(0)] }]),
      sources
    );
    expect(out.answer).toBeNull();
  });

  it("truncates long quotes to 300 characters plus an ellipsis", () => {
    const out = verifyAnswer(
      result([{ text: "x", citations: [cite(0, 0, "a".repeat(400))] }]),
      sources
    );
    expect(out.citations[0].quote).toEqual(`${"a".repeat(300)}…`);
  });

  it("discards verbatim text when its only citation is invalid", () => {
    const out = verifyAnswer(
      result([{ text: "25 days of holiday per year.", citations: [cite(7)] }]),
      sources
    );
    expect(out.answer).toBeNull();
  });

  it("drops short uncited text and counts it", () => {
    const out = verifyAnswer(
      result([
        { text: "25 days", citations: [] },
        { text: "Yes.", citations: [cite(0)] },
      ]),
      sources
    );
    expect(out.answer).toEqual("Yes.");
    expect(out.droppedSegments).toEqual(1);
  });

  it("dedupes citations and lets a model citation overwrite a verbatim one", () => {
    const out = verifyAnswer(
      result([
        { text: "25 days of holiday per year.", citations: [] },
        { text: "Yes.", citations: [cite(0, 0, "model quote")] },
        { text: "Again.", citations: [cite(0, 0, "second")] },
      ]),
      sources
    );
    expect(out.citations).toHaveLength(1);
    expect(out.citations[0].quote).toEqual("second");
  });

  it("takes the heading from the cited section, not the first", () => {
    const multi = [source("B", ["# One\nfirst", "# Two\nsecond"])];
    const out = verifyAnswer(
      result([{ text: "Second.", citations: [cite(0, 1)] }]),
      multi
    );
    expect(out.citations[0].heading).toEqual("Two");
  });

  it("abstains when NO_ANSWER appears in any segment, even a dropped one", () => {
    const out = verifyAnswer(
      result([
        { text: "25 days.", citations: [cite(0)] },
        { text: "NO_ANSWER", citations: [] },
      ]),
      sources
    );
    expect(out.answer).toBeNull();
  });
});
