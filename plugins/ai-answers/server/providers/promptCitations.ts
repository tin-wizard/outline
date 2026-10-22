import type { ProviderCitation } from "../contract";
import type { AnswerSource } from "../retrieve";
import { MAX_CITED_SECTIONS, normalise } from "../verify";

/**
 * Instructions appended to the system prompt for providers without native
 * citations. The model writes one JSON object per Markdown line; each claimed
 * quote is checked against the sent sections by `parsePromptedBlock` and the
 * result again by `AnswerVerifier`.
 */
export const PROMPT_CITATION_FORMAT = [
  "Output format: write the answer as JSON Lines, one JSON object per line and nothing else, no code fences.",
  'Each object is {"text": string, "cites": [{"id": number, "quote": string}]} and holds exactly one line of the Markdown answer: a paragraph, heading, list item or table row.',
  'Write {"text": "", "cites": []} for an empty line between Markdown blocks.',
  '"id" is the number of the search result the line relies on; search results are numbered from 1 in the order given.',
  '"quote" is a passage copied character for character from that search result that supports the line. Never shorten, paraphrase or join passages from different places.',
  'Every line that states a fact must cite at least one quote. Headings, table header and separator rows and statements of what the documents do not cover use "cites": [].',
  `If the search results do not contain the answer, write exactly {"text": "NO_ANSWER", "cites": []}.`,
].join("\n");

/**
 * Parses one line of a model answer written in `PROMPT_CITATION_FORMAT`,
 * mapping each claimed `{id, quote}` onto the smallest range of sections of
 * source `id` (1-based) whose normalised text contains the normalised quote.
 * Never repairs a citation: a malformed line, an unknown id or a quote found
 * in no range of at most `MAX_CITED_SECTIONS` sections of that source makes
 * the whole line null.
 *
 * @param line one line of model output.
 * @param sources the sources that were sent, in order.
 * @returns the line's Markdown text and its citations, or null.
 */
export function parsePromptedBlock(
  line: string,
  sources: AnswerSource[]
): { text: string; citations: ProviderCitation[] } | null {
  const parsed = parseLine(line);
  if (!parsed) {
    return null;
  }
  const citations: ProviderCitation[] = [];
  for (const cite of parsed.cites) {
    const citation = locate(cite, sources);
    if (!citation) {
      return null;
    }
    citations.push(citation);
  }
  return { text: parsed.text, citations };
}

interface PromptedCite {
  id: number;
  quote: string;
}

interface PromptedLine {
  text: string;
  cites: PromptedCite[];
}

function parseLine(line: string): PromptedLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    typeof value.text !== "string" ||
    !Array.isArray(value.cites)
  ) {
    return null;
  }
  const cites: PromptedCite[] = [];
  for (const cite of value.cites) {
    if (
      !isRecord(cite) ||
      typeof cite.id !== "number" ||
      typeof cite.quote !== "string"
    ) {
      return null;
    }
    cites.push({ id: cite.id, quote: cite.quote });
  }
  return { text: value.text, cites };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The smallest, then earliest, section range of source `id` holding the quote. */
function locate(
  cite: PromptedCite,
  sources: AnswerSource[]
): ProviderCitation | null {
  const sourceIndex = cite.id - 1;
  const source = Number.isInteger(cite.id) ? sources[sourceIndex] : undefined;
  const quote = normalise(cite.quote);
  if (!source || !quote) {
    return null;
  }
  // Same normalisation and joining as the verifier's resolveCitation.
  for (let width = 1; width <= MAX_CITED_SECTIONS; width++) {
    for (let start = 0; start + width <= source.sections.length; start++) {
      const passage = normalise(
        source.sections.slice(start, start + width).join("\n")
      );
      if (passage.includes(quote)) {
        return {
          sourceIndex,
          sectionIndex: start,
          endSectionIndex: start + width,
          quote: cite.quote,
        };
      }
    }
  }
  return null;
}
