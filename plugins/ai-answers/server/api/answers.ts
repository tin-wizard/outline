import Router from "koa-router";
import { TeamPreference } from "@shared/types";
import { toError } from "@shared/utils/error";
import { AuthorizationError } from "@server/errors";
import Logger from "@server/logging/Logger";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import validate from "@server/middlewares/validate";
import { SearchQuery } from "@server/models";
import { SearchQuerySource } from "@server/models/SearchQuery";
import {
  presentDocument,
  presentPolicies,
  presentSearchQuery,
} from "@server/presenters";
import type { APIContext } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import { getClient } from "../anthropicClient";
import { generateAnswer } from "../generate";
import { retrieveSources } from "../retrieve";
import * as T from "./schema";

const router = new Router();

router.post(
  "documents.answerQuestion",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  validate(T.DocumentsAnswerQuestionSchema),
  async (ctx: APIContext<T.DocumentsAnswerQuestionReq>) => {
    const { user } = ctx.state.auth;
    const { query } = ctx.input.body;

    if (!user.team.getPreference(TeamPreference.AIAnswers)) {
      throw AuthorizationError("AI answers are not enabled for this workspace");
    }

    const startedAt = Date.now();
    const sources = await retrieveSources(user, ctx.input.body);
    const documents = sources.map((source) => source.document);

    // Generation is best-effort: fall back to the retrieved documents alone.
    let answer: string | null = null;
    let citations: Awaited<ReturnType<typeof generateAnswer>>["citations"] = [];
    try {
      ({ answer, citations } = await generateAnswer(
        getClient(),
        query,
        sources
      ));
    } catch (error) {
      Logger.warn("AI answers generation failed", {
        error: toError(error).message,
      });
    }

    const search = await SearchQuery.create({
      userId: user.id,
      teamId: user.teamId,
      // auth.type values are a subset of search sources, as in documents.search
      source:
        (ctx.state.auth.type as unknown as SearchQuerySource) ||
        SearchQuerySource.App,
      query,
      results: documents.length,
      duration: Date.now() - startedAt,
    });

    ctx.body = {
      documents: await Promise.all(
        documents.map((document) => presentDocument(ctx, document))
      ),
      policies: presentPolicies(user, documents),
      // Returned to the client but deliberately not stored on the search row.
      answer,
      search: presentSearchQuery(search),
      citations,
    };
  }
);

export default router;
