import type { Filter } from "@shared/helpers/FilterHelper";
import type { Document, User } from "@server/models";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import type { StoredScope } from "@server/models/AIConversationTurn";
import {
  authorizeFilterFields,
  combineFilters,
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

/** Most collections one question may be scoped to. */
export const MAX_SCOPE_COLLECTIONS = 10;

/** Most documents one question may be scoped to (each with its children). */
export const MAX_SCOPE_DOCUMENTS = 20;

/** The scope fields of an `ai.ask` request. */
export type ScopeParams = Partial<
  Pick<
    T.AIAskReq["body"],
    | "collectionId"
    | "collectionIds"
    | "documentId"
    | "documentIds"
    | "dateFrom"
    | "dateTo"
  >
>;

/** Retrieved sources and how many candidates were fetched before the cut. */
export interface Retrieval {
  sources: AnswerSource[];
  /**
   * Readable, not AI-excluded documents the search stages returned before
   * the cut to `MAX_DOCUMENTS`, at most `FETCH_LIMIT` (20). Not a total.
   */
  candidatesFetched: number;
}

/**
 * The scope of a question with the single and the list parameters merged,
 * deduplicated, in request order.
 *
 * @param params the scope parameters of the request.
 * @returns the scope as stored with the turn.
 */
export function askScope(params: ScopeParams): StoredScope {
  const unique = (one: string | undefined, many: string[] | undefined) => [
    ...new Set([...(one ? [one] : []), ...(many ?? [])]),
  ];
  return {
    collectionIds: unique(params.collectionId, params.collectionIds),
    documentIds: unique(params.documentId, params.documentIds),
    ...(params.dateFrom ? { dateFrom: params.dateFrom } : {}),
    ...(params.dateTo ? { dateTo: params.dateTo } : {}),
  };
}

/**
 * The search filter of a scope, ANDing collections, documents and the
 * updatedAt range (whole UTC days, both ends inclusive).
 *
 * @param scope the scope.
 * @returns the filter, or undefined when the scope is empty.
 */
export function scopeFilter(scope: StoredScope): Filter | undefined {
  const leaves: Filter[] = [];
  if (scope.collectionIds.length > 0) {
    leaves.push({
      field: "collectionId",
      operator: "in",
      value: scope.collectionIds,
    });
  }
  if (scope.documentIds.length > 0) {
    leaves.push({
      field: "documentId",
      operator: "in",
      value: scope.documentIds,
    });
  }
  if (scope.dateFrom) {
    leaves.push({
      field: "updatedAt",
      operator: "gte",
      value: utcDayStart(scope.dateFrom, 0),
    });
  }
  if (scope.dateTo) {
    leaves.push({
      field: "updatedAt",
      operator: "lt",
      value: utcDayStart(scope.dateTo, 1),
    });
  }
  return combineFilters(leaves);
}

/**
 * Finds the documents the user may read that best match a question, and cuts
 * them down to the sections most relevant to it. Permissions are enforced by
 * the search provider, so nothing the user cannot read is ever returned.
 * Documents in collections excluded from AI answers are dropped for everyone.
 *
 * @param user the user asking the question.
 * @param body the question and its scope.
 * @param signal aborts between retrieval stages when the caller goes away.
 * @returns the sources, best match first; empty when nothing matches.
 * @throws AuthorizationError when any scoped collection or document is not
 * readable, unknown or in another workspace (one error for all three).
 */
export async function retrieveSources(
  user: User,
  body: { query: string } & ScopeParams,
  signal?: AbortSignal
): Promise<AnswerSource[]> {
  return (await retrieveWithCounts(user, body, signal)).sources;
}

/**
 * Like `retrieveSources`, also reporting how many candidates were fetched.
 *
 * @param user the user asking the question.
 * @param body the question and its scope.
 * @param signal aborts between retrieval stages when the caller goes away.
 * @returns the sources and the candidate count.
 * @throws AuthorizationError when any scoped collection or document is not
 * readable, unknown or in another workspace.
 */
export async function retrieveWithCounts(
  user: User,
  body: { query: string } & ScopeParams,
  signal?: AbortSignal
): Promise<Retrieval> {
  // The raw query never reaches the search provider; markers are not keywords.
  const keywords = toKeywords(
    redactSecrets(body.query).text.replace(/\[REDACTED:[a-z_]+\]/g, " ")
  );
  if (keywords.length === 0) {
    return { sources: [], candidatesFetched: 0 };
  }

  const filter = scopeFilter(askScope(body));
  if (filter) {
    // Authorises every collection id of the `in` leaf; the expansion below
    // authorises every document id. Unknown, foreign and unreadable ids all
    // raise the same AuthorizationError.
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
  const candidatesFetched = Math.min(documents.length, FETCH_LIMIT);
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
  return { sources, candidatesFetched };
}

/** ISO time of 00:00 UTC on `date` (YYYY-MM-DD) plus `days`. */
function utcDayStart(date: string, days: number): string {
  const start = new Date(`${date}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() + days);
  return start.toISOString();
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
