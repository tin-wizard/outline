import type { Filter } from "@shared/helpers/FilterHelper";
import { Collection } from "@server/models";
import type { Document, User } from "@server/models";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import {
  authorizeFilterFields,
  legacyParamsToFilter,
} from "@server/models/helpers/Filters";
import { expandDocumentIdLeaves } from "@server/routes/api/documents/documents";
import SearchProviderManager from "@server/utils/SearchProviderManager";
import type * as T from "./api/schema";
import { redactSecrets } from "./redact";
import {
  selectSections,
  splitIntoSections,
  toKeywordAndQuery,
  toKeywordQuery,
  toKeywords,
} from "./text";

/** A document and the sections of it that are sent to the model, secrets redacted. */
export interface AnswerSource {
  document: Document;
  sections: string[];
}

const MAX_DOCUMENTS = 5;
// Extra candidates so documents dropped by AI exclusion do not starve results.
// Fails closed: if 20+ excluded documents outrank every other match, the
// answer simply has fewer sources.
const FETCH_LIMIT = MAX_DOCUMENTS * 4;
const MAX_CHARS_PER_DOCUMENT = 20_000;
// Fewer exact (all-keyword) matches than this widens the query to any keyword.
const MIN_AND_RESULTS = 2;

/**
 * Finds the documents the user may read that best match a question, and cuts
 * them down to the sections most relevant to it. Permissions are enforced by
 * the search provider, so nothing the user cannot read is ever returned.
 * Documents in collections excluded from AI answers are dropped for everyone.
 *
 * @param user the user asking the question.
 * @param body the validated request body.
 * @returns the sources, best match first; empty when nothing matches.
 */
export async function retrieveSources(
  user: User,
  body: T.DocumentsAnswerQuestionReq["body"]
): Promise<AnswerSource[]> {
  // The raw query never reaches the search provider; markers are not keywords.
  const keywords = toKeywords(
    redactSecrets(body.query).text.replace(/\[REDACTED:[a-z_]+\]/g, " ")
  );
  if (keywords.length === 0) {
    return [];
  }

  const filter = legacyParamsToFilter({
    userId: body.userId,
    collectionId: body.collectionId,
    documentId: body.documentId,
    statusFilter: body.statusFilter,
    dateFilter: body.dateFilter,
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
  let documents = await readable(await search(toKeywordAndQuery(keywords)));
  if (documents.length < MIN_AND_RESULTS) {
    documents = await readable(await search(toKeywordQuery(keywords)));
  }
  if (documents.length === 0) {
    // Same permission gate as search: the provider's title search for the user.
    documents = await readable(
      await searchTitles(user, keywords, resolvedFilter)
    );
  }
  documents = documents.slice(0, MAX_DOCUMENTS);

  const sources: AnswerSource[] = [];
  for (const document of documents) {
    // Redacted before splitting so a key block cut across sections is still caught.
    const { text: markdown } = redactSecrets(
      await DocumentHelper.toMarkdown(document, { includeTitle: false })
    );
    const sections = selectSections(
      splitIntoSections(markdown),
      keywords,
      MAX_CHARS_PER_DOCUMENT
    );
    if (sections.length > 0) {
      sources.push({ document, sections });
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
  const found = await Promise.all(
    keywords.map((keyword) =>
      provider.searchTitlesForUser(user, {
        query: keyword,
        filter,
        limit: FETCH_LIMIT,
        offset: 0,
      })
    )
  );
  const required = Math.min(2, keywords.length);
  const scored = new Map<string, { document: Document; hits: number }>();
  for (const document of found.flat()) {
    const title = document.title.toLowerCase();
    scored.set(document.id, {
      document,
      hits: keywords.filter((keyword) => title.includes(keyword)).length,
    });
  }
  return [...scored.values()]
    .filter((item) => item.hits >= required)
    .sort((a, b) => b.hits - a.hits)
    .map((item) => item.document);
}

/** Drops documents in collections excluded from AI answers. */
async function dropAIExcluded(
  user: User,
  documents: Document[]
): Promise<Document[]> {
  const collectionIds = [
    ...new Set(documents.map((d) => d.collectionId)),
  ].filter((id): id is string => !!id);
  if (collectionIds.length === 0) {
    return documents;
  }
  const excluded = new Set(
    (
      await Collection.findAll({
        where: { id: collectionIds, teamId: user.teamId, aiExcluded: true },
        attributes: ["id"],
        // A trashed collection's documents can still be searched.
        paranoid: false,
      })
    ).map((c) => c.id)
  );
  return documents.filter(
    (d) => !d.collectionId || !excluded.has(d.collectionId)
  );
}
