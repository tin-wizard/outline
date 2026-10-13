import Router from "koa-router";
import { TeamPreference } from "@shared/types";
import { AuthorizationError } from "@server/errors";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import validate from "@server/middlewares/validate";
import type { APIContext } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import * as T from "./schema";

const router = new Router();

router.post(
  "documents.answerQuestion",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  validate(T.DocumentsAnswerQuestionSchema),
  async (ctx: APIContext<T.DocumentsAnswerQuestionReq>) => {
    const { user } = ctx.state.auth;

    if (!user.team.getPreference(TeamPreference.AIAnswers)) {
      throw AuthorizationError("AI answers are not enabled for this workspace");
    }

    ctx.body = { documents: [], policies: [], search: null, citations: [] };
  }
);

export default router;
