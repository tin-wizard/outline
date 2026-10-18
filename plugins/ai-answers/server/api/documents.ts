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

// Extra title matches so excluded or unreadable ones do not starve the list.
const OVERFETCH = 3;

// Documents a question may be scoped to, for the "Specific documents" picker.
// Unlike documents.search_titles, documents in AI-excluded collections are
// left out (retrieval would ignore them), as are templates and other users'
// drafts: the same gate as stored answers (`readableDocuments`).
router.post(
  "ai.documents",
  rateLimiter(RateLimiterStrategy.OneHundredPerMinute),
  auth(),
  validate(T.AIDocumentsSchema),
  async (ctx: APIContext<T.AIDocumentsReq>) => {
    const { user } = ctx.state.auth;
    const { query, limit } = ctx.input.body;

    assertAIAnswersAllowed(user);

    // shortcut: when more than limit * 3 newer matches are excluded or
    // unreadable, fewer than `limit` come back; page the provider if needed.
    const found = await SearchProviderManager.getProvider().searchTitlesForUser(
      user,
      { query: query || undefined, limit: limit * OVERFETCH, offset: 0 }
    );
    const readable = await readableDocuments(
      user,
      found.map((d) => d.id)
    );
    const documents = found.filter((d) => readable.has(d.id)).slice(0, limit);
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
