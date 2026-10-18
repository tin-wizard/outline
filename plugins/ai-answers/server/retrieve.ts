import type { Filter } from "@shared/helpers/FilterHelper";
import type { Document, User } from "@server/models";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import {
  authorizeFilterFields,
  legacyParamsToFilter,
} from "@server/models/helpers/Filters";
import { expandDocumentIdLeaves } from "@server/routes/api/documents/documents";
import SearchProviderManager from "@server/utils/SearchProviderManager";
import { dropAIExcluded } from "@server/utils/aiExclusion";
import type * as T from "./api/schema";
import { redactSecrets } from "./redact";
import { sectionTargets } from "./anchors";
import {
  selectSectionIndices,
  splitIntoSections,
  toKeywordAndQuery,
  toKeywordQuery,
  toKeywords,
} from "./text";

/** A document and the sections of it that are sent to the model, secrets redacted. */
export interface AnswerSource {
  document: Document;
  sections: string[];
  /**
   * The editor's heading id for each section (see `sectionAnchors`), aligned
   * with `sections`; undefined entries have no safe anchor.
   */
  anchors?: (string | undefined)[];
  /** The plain heading text for each section (see `sectionTargets`), aligned with `sections`. */
  headings?: (string | undefined)[];
}

const MAX_DOCUMENTS = 5;
// Extra candidates so documents dropped by AI exclusion do not starve results.
// Fails closed: if 20+ excluded documents outrank every other match, the
// answer simply has fewer sources.
const FETCH_LIMIT = MAX_DOCUMENTS * 4;
const MAX_CHARS_PER_DOCUMENT = 20_000;
// Fewer exact (all-keyword) matches than this widens the query to any keyword.
const MIN_AND_RESULTS = 2;
const MAX_TITLE_TERMS = 4;

/**
 * Finds the documents the user may read that best match a question, and cuts
 * them down to the sections most relevant to it. Permissions are enforced by
 * the search provider, so nothing the user cannot read is ever returned.
 * Documents in collections excluded from AI answers are dropped for everyone.
 *
 * @param user the user asking the question.
 * @param body the validated request body.
 * @param signal aborts between retrieval stages when the caller goes away.
 * @returns the sources, best match first; empty when nothing matches.
 */
export async function retrieveSources(
  user: User,
  body: Pick<T.AIAskReq["body"], "query" | "collectionId" | "documentId">,
  signal?: AbortSignal
): Promise<AnswerSource[]> {
  // The raw query never reaches the search provider; markers are not keywords.
  const keywords = toKeywords(
    redactSecrets(body.query).text.replace(/\[REDACTED:[a-z_]+\]/g, " ")
  );
  if (keywords.length === 0) {
    return [];
  }

  const filter = legacyParamsToFilter({
    collectionId: body.collectionId,
    documentId: body.documentId,
  });
  if (filter) {
    await authorizeFilterFields(user, filter);
  }
  const resolvedFilter = filter
    ? await expandDocumentIdLeaves(filter, { user })
    : undefined;

  const provider = SearchProviderManager.getProvider();
  const search = async (query: string) =>
    (
      await provider.searchForUser(user, {
        query,
        filter: resolvedFilter,
        limit: FETCH_LIMIT,
        offset: 0,
      })
    ).results.map((r) => r.document);

  // shortcut: the provider's search always applies its popularity boost and
  // exposes no option to disable it; revisit if the provider gains one.
  // Exclusion is applied at every stage so that excluded matches never count
  // towards "enough results" and never reach the model.
  const readable = (documents: Document[]) => dropAIExcluded(user, documents);
  const andQuery = toKeywordAndQuery(keywords);
  let documents: Document[] = [];
  // An empty query would make the provider skip its text filter and return
  // every readable document, so the AND stage only runs with real terms.
  if (andQuery) {
    documents = await readable(await search(andQuery));
  }
  if (documents.length < MIN_AND_RESULTS) {
    signal?.throwIfAborted();
    const wider = await readable(await search(toKeywordQuery(keywords)));
    const seen = new Set(documents.map((d) => d.id));
    documents = [...documents, ...wider.filter((d) => !seen.has(d.id))];
  }
  if (documents.length === 0) {
    signal?.throwIfAborted();
    // Same permission gate as search: the provider's title search for the user.
    documents = await readable(
      await searchTitles(user, keywords, resolvedFilter)
    );
  }
  signal?.throwIfAborted();
  documents = documents.slice(0, MAX_DOCUMENTS);

  const sources: AnswerSource[] = [];
  for (const document of documents) {
    // Redacted before splitting so a key block cut across sections is still caught.
    const { text: markdown } = redactSecrets(
      await DocumentHelper.toMarkdown(document, { includeTitle: false })
    );
    const all = splitIntoSections(markdown);
    const targets = sectionTargets(document, all);
    const chosen = selectSectionIndices(all, keywords, MAX_CHARS_PER_DOCUMENT);
    if (chosen.length > 0) {
      sources.push({
        document,
        sections: chosen.map((i) => all[i]),
        anchors: chosen.map((i) => targets[i]?.id),
        headings: chosen.map((i) => targets[i]?.heading),
      });
    }
  }
  return sources;
}

/**
 * Finds documents whose title contains at least two keywords (one when there
 * is only one), best match first. Goes through the search provider's title
 * search, which applies the user's permissions and the scope filter.
 */
async function searchTitles(
  user: User,
  keywords: string[],
  filter: Filter | undefined
): Promise<Document[]> {
  const provider = SearchProviderManager.getProvider();
  // Short words ("an", "do") would match inside longer title words, and a
  // compound only counts when it has no parts to avoid double counting.
  const long = keywords.filter((keyword) => [...keyword].length >= 3);
  const parts = long.filter((keyword) => !/[/\-_.]/.test(keyword));
  const terms = [...(parts.length > 0 ? parts : long)]
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_TITLE_TERMS);
  const found = await Promise.all(
    terms.map((keyword) =>
      provider.searchTitlesForUser(user, {
        query: keyword,
        filter,
        limit: FETCH_LIMIT,
        offset: 0,
      })
    )
  );
  const required = Math.min(2, terms.length);
  const scored = new Map<string, { document: Document; hits: number }>();
  for (const document of found.flat()) {
    const title = document.title.toLowerCase();
    scored.set(document.id, {
      document,
      hits: terms.filter((keyword) => title.includes(keyword)).length,
    });
  }
  return [...scored.values()]
    .filter((item) => item.hits >= required)
    .sort((a, b) => b.hits - a.hits)
    .map((item) => item.document);
}
