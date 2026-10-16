import { NO_ANSWER, type ProviderResult } from "./contract";
import type { AnswerSource } from "./retrieve";
import { headingOf } from "./text";

/** A passage of a document that supports the answer. */
export interface AnswerCitation {
  documentId: string;
  title: string;
  url: string;
  heading?: string;
  quote: string;
}

/** The outcome of asking a question. `answer` is null when nothing was found. */
export interface AnswerResult {
  answer: string | null;
  citations: AnswerCitation[];
}

const MAX_QUOTE = 300;

/** Shortest uncited text that can be trusted as a verbatim copy of a source. */
const MIN_GROUNDED_LENGTH = 25;

function truncate(text: string): string {
  return text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text;
}

/** Lowercases and strips markdown markers and extra whitespace for comparison. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Applies the trust rules to a provider result. A segment is kept only when
 * it carries a citation that maps to a real section that was sent, or when it
 * is copied verbatim (at least 25 characters) from a sent section; invented
 * uncited text is dropped. The answer is returned only with at least one real
 * model citation, and only when the provider finished cleanly.
 *
 * @param result the unverified provider result.
 * @param sources the sources that were sent, in order.
 * @returns the verified answer and citations, or `answer: null`.
 */
export function verifyAnswer(
  result: ProviderResult,
  sources: AnswerSource[]
): AnswerResult {
  // Anything but a clean finish (refusal, max_tokens, pause_turn, tool_use) may be partial.
  if (result.finishReason !== "stop") {
    return { answer: null, citations: [] };
  }

  const normalisedSections = sources.flatMap((source) =>
    source.sections.map((section) => ({
      source,
      section,
      text: normalise(section),
    }))
  );
  const parts: string[] = [];
  const citations = new Map<string, AnswerCitation>();
  let hasModelCitation = false;
  for (const segment of result.segments) {
    let backed = false;
    for (const citation of segment.citations) {
      const source = sources[citation.sourceIndex];
      const section = source?.sections[citation.sectionIndex];
      if (!source || section === undefined) {
        continue;
      }
      const heading = headingOf(section);
      citations.set(`${source.document.id}:${heading ?? ""}`, {
        documentId: source.document.id,
        title: source.document.title,
        url: source.document.url,
        heading,
        quote: truncate(citation.quote),
      });
      backed = true;
      hasModelCitation = true;
    }
    const text = segment.text.trim();
    if (backed) {
      parts.push(text);
      continue;
    }

    const needle = normalise(text);
    if (needle.length < MIN_GROUNDED_LENGTH) {
      continue;
    }
    const match = normalisedSections.find((s) => s.text.includes(needle));
    if (!match) {
      continue;
    }
    const heading = headingOf(match.section);
    const key = `${match.source.document.id}:${heading ?? ""}`;
    if (!citations.has(key)) {
      citations.set(key, {
        documentId: match.source.document.id,
        title: match.source.document.title,
        url: match.source.document.url,
        heading,
        quote: truncate(text),
      });
    }
    parts.push(text);
  }

  const answer = parts.join(" ").trim();
  if (!answer || answer.includes(NO_ANSWER) || !hasModelCitation) {
    return { answer: null, citations: [] };
  }
  return { answer, citations: [...citations.values()] };
}
