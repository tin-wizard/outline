import Router from "koa-router";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import validate from "@server/middlewares/validate";
import { Document } from "@server/models";
import type { APIContext } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import SearchProviderManager from "@server/utils/SearchProviderManager";
import { assertAIAnswersAllowed } from "../access";
import { readableDocuments } from "../conversation";
import { accessibleCollections } from "../presenters/source";
import { redactSecrets } from "../redact";
import * as T from "./schema";

const router = new Router();

// Each page over-fetches so excluded or unreadable matches rarely starve the
// list; at most MAX_PAGES pages are read to top it up.
const OVERFETCH = 3;
const MAX_PAGES = 3;

// Documents a question may be scoped to, for the "Specific documents" picker.
// Unlike documents.search_titles, it offers only what retrieval can use:
// readable (`readableDocuments`: permission, not AI-excluded), published and
// not a template. Drafts are left out, even the user's own, because full-text
// retrieval does not reliably find them. Archived documents stay, since
// retrieval uses them too.
router.post(
  "ai.documents",
  rateLimiter(RateLimiterStrategy.OneHundredPerMinute),
  auth(),
  validate(T.AIDocumentsSchema),
  async (ctx: APIContext<T.AIDocumentsReq>) => {
    const { user } = ctx.state.auth;
    const { query, limit } = ctx.input.body;

    assertAIAnswersAllowed(user);

    const provider = SearchProviderManager.getProvider();
    const pageSize = limit * OVERFETCH;
    const documents: Document[] = [];
    for (let page = 0; page < MAX_PAGES && documents.length < limit; page++) {
      const found = await provider.searchTitlesForUser(user, {
        query: query || undefined,
        limit: pageSize,
        offset: page * pageSize,
      });
      const readable = await readableDocuments(
        user,
        found.map((d) => d.id)
      );
      documents.push(
        ...found.filter(
          (d) => readable.has(d.id) && !!d.publishedAt && !d.template
        )
      );
      if (found.length < pageSize) {
        break;
      }
    }
    documents.splice(limit);
    const collections = await accessibleCollections(
      user,
      documents.map((d) => d.collectionId)
    );

    ctx.body = {
      data: documents.map((d) => {
        const title = redactSecrets(d.title || "Untitled").text;
        const collection = d.collectionId
          ? collections.get(d.collectionId)
          : undefined;
        return {
          id: d.id,
          title,
          url: Document.getPath({ title, urlId: d.urlId }),
          ...(collection && d.collectionId
            ? { collectionId: d.collectionId, collectionName: collection.name }
            : {}),
        };
      }),
    };
  }
);

export default router;
