import { randomUUID } from "node:crypto";
import { Document } from "@server/models";
import type {
  ProviderStreamEvent,
  StreamRequest,
  StreamingProvider,
} from "../contract";
import type { AnswerSource } from "../retrieve";
import { describeProviderContract, type FakeScript } from "./contractSuite";
import { parsePromptedBlock, PROMPT_CITATION_FORMAT } from "./promptCitations";

function source(title: string, sections: string[]): AnswerSource {
  const document = Document.build({ id: randomUUID(), title });
  return { document, sections };
}

const sources = [
  source("Leave", [
    "# Leave\nEmployees receive 25 days of paid holiday per year.",
    "Requests go through the HR portal.",
    "Unused days expire at the end of March.",
  ]),
  source("Security", ["# Security\nSSO is supported on every plan."]),
];

const line = (text: string, cites: { id: number; quote: string }[]) =>
  JSON.stringify({ text, cites });

describe("PROMPT_CITATION_FORMAT", () => {
  it("states the line format and 1-based ids", () => {
    expect(PROMPT_CITATION_FORMAT).toContain('"cites"');
    expect(PROMPT_CITATION_FORMAT).toContain("numbered from 1");
  });
});

describe("parsePromptedBlock", () => {
  it("maps a 1-based id and quote onto the containing section", () => {
    expect(
      parsePromptedBlock(
        line("SSO is supported on every plan.", [
          { id: 2, quote: "SSO is supported on every plan" },
        ]),
        sources
      )
    ).toEqual({
      text: "SSO is supported on every plan.",
      citations: [
        {
          sourceIndex: 1,
          sectionIndex: 0,
          endSectionIndex: 1,
          quote: "SSO is supported on every plan",
        },
      ],
    });
  });

  it("returns null when the quote is in no section of the source", () => {
    expect(
      parsePromptedBlock(
        line("Staff get 40 days.", [{ id: 1, quote: "Staff get 40 days" }]),
        sources
      )
    ).toBeNull();
  });

  it("returns null when the quote is in a different source than the id", () => {
    expect(
      parsePromptedBlock(
        line("SSO is supported.", [{ id: 1, quote: "SSO is supported" }]),
        sources
      )
    ).toBeNull();
  });

  it.each([0, 3, -1, 1.5])("returns null for id %s", (id) => {
    expect(
      parsePromptedBlock(
        line("x", [{ id, quote: "SSO is supported" }]),
        sources
      )
    ).toBeNull();
  });

  it("returns null when any one citation fails", () => {
    expect(
      parsePromptedBlock(
        line("SSO is supported.", [
          { id: 2, quote: "SSO is supported" },
          { id: 2, quote: "invented passage text" },
        ]),
        sources
      )
    ).toBeNull();
  });

  it("finds the smallest range for a quote spanning sections", () => {
    const parsed = parsePromptedBlock(
      line("Requests use the HR portal; unused days expire.", [
        {
          id: 1,
          quote: "HR portal. Unused days expire",
        },
      ]),
      sources
    );
    expect(parsed?.citations).toEqual([
      {
        sourceIndex: 0,
        sectionIndex: 1,
        endSectionIndex: 3,
        quote: "HR portal. Unused days expire",
      },
    ]);
  });

  it("matches across case, Markdown markers and whitespace like the verifier", () => {
    const parsed = parsePromptedBlock(
      line("x", [{ id: 1, quote: "LEAVE   employees receive 25 days" }]),
      sources
    );
    expect(parsed?.citations[0]).toMatchObject({
      sectionIndex: 0,
      endSectionIndex: 1,
    });
  });

  it("keeps uncited text, e.g. headings and gap statements", () => {
    expect(parsePromptedBlock(line("## Leave", []), sources)).toEqual({
      text: "## Leave",
      citations: [],
    });
  });

  it.each([
    "not json",
    "[]",
    '{"text": 1, "cites": []}',
    '{"text": "x"}',
    '{"text": "x", "cites": [{"id": "1", "quote": "SSO is supported"}]}',
    '{"text": "x", "cites": [{"id": 2}]}',
    line("x", [{ id: 2, quote: "  " }]),
  ])("returns null for malformed line %s", (raw) => {
    expect(parsePromptedBlock(raw, sources)).toBeNull();
  });
});

/** A minimal adapter on the prompted-citation format, driven by a script. */
function fakeProvider(script: FakeScript): StreamingProvider {
  return {
    id: "fake",
    model: "fake-model",
    stream: (request) => fakeStream(script, request),
    classify: (error) =>
      error.message.includes("credit balance") ? "billing" : "other",
  };
}

async function* fakeStream(
  script: FakeScript,
  request: StreamRequest
): AsyncGenerator<ProviderStreamEvent> {
  let buffer = "";
  const emit = (raw: string): ProviderStreamEvent[] => {
    if (!raw.trim()) {
      return [{ type: "text", text: "\n", citations: [] }];
    }
    const parsed = parsePromptedBlock(raw, request.sources);
    return parsed
      ? [
          {
            type: "text",
            text: `${parsed.text}\n`,
            citations: parsed.citations,
          },
        ]
      : [];
  };
  for (const chunk of script.chunks) {
    if (request.signal?.aborted) {
      throw new Error("aborted");
    }
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      yield* emit(raw);
    }
  }
  if (buffer) {
    yield* emit(buffer);
  }
  if (script.error) {
    throw script.error;
  }
  yield {
    type: "end",
    finishReason: "stop",
    refused: false,
    usage: script.usage ?? null,
  };
}

describeProviderContract(
  "fake prompted-citation provider",
  fakeProvider,
  new Error("Your credit balance is too low")
);
