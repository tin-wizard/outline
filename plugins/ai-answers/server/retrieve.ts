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
  toKeywordQuery,
  toKeywords,
} from "./text";

/** A document and the sections of it that are sent to the model, secrets redacted. */
export interface AnswerSource {
  document: Document;
  sections: string[];
}

const MAX_DOCUMENTS = 5;
const MAX_CHARS_PER_DOCUMENT = 20_000;

/**
 * Finds the documents the user may read that best match a question, and cuts
 * them down to the sections most relevant to it. Permissions are enforced by
 * the search provider, so nothing the user cannot read is ever returned.
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

  const { results } = await SearchProviderManager.getProvider().searchForUser(
    user,
    {
      query: toKeywordQuery(keywords),
      filter: resolvedFilter,
      limit: MAX_DOCUMENTS,
      offset: 0,
    }
  );

  const sources: AnswerSource[] = [];
  for (const { document } of results) {
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
