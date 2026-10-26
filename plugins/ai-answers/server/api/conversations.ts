import Router from "koa-router";
import { Op, Sequelize, type WhereOptions } from "sequelize";
import { NotFoundError } from "@server/errors";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import validate from "@server/middlewares/validate";
import { AIConversation, type User } from "@server/models";
import { authorize } from "@server/policies";
import pagination, {
  paginateQuery,
} from "@server/routes/api/middlewares/pagination";
import { QueryHelper } from "@server/storage/QueryHelper";
import { sequelize } from "@server/storage/database";
import { AuthenticationType, type APIContext } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import { assertHistoryAllowed } from "../access";
import { deleteConversation } from "../conversation";
import {
  conversationTitle,
  findOwnConversation,
  findTurns,
  presentTurns,
} from "../history";
import { presentAIConversation } from "../presenters/aiConversation";
import * as T from "./schema";

const router = new Router();

/**
 * Loads one of the user's conversations. A missing and a foreign id get the
 * same 404, so ids cannot be probed.
 */
async function loadOwn(user: User, id: string): Promise<AIConversation> {
  const conversation = await findOwnConversation(user, id);
  if (!conversation) {
    throw NotFoundError();
  }
  return conversation;
}

// Every query below is scoped by team and owner explicitly: row-level
// security only covers the request transaction, and the production database
// role bypasses it.
router.post(
  "aiConversations.list",
  rateLimiter(RateLimiterStrategy.OneHundredPerMinute),
  // Session only: API keys and OAuth tokens never reach anyone's chats.
  auth({ type: AuthenticationType.APP }),
  pagination(),
  validate(T.AIConversationsListSchema),
  async (ctx: APIContext<T.AIConversationsListReq>) => {
    const { user } = ctx.state.auth;
    const { query, pinned } = ctx.input.body;

    // Metadata only and owner scoped, so it needs no AI or role gate: people
    // can always find (and delete) what was stored about them.

    const conditions: WhereOptions<AIConversation>[] = [
      { teamId: user.teamId, userId: user.id },
    ];
    if (pinned !== undefined) {
      conditions.push({ pinnedAt: pinned ? { [Op.ne]: null } : null });
    }
    if (query) {
      const pattern = QueryHelper.likeContains(query);
      conditions.push({
        [Op.or]: [
          { title: { [Op.iLike]: pattern } },
          Sequelize.literal(
            `EXISTS (SELECT 1 FROM "ai_conversation_turns" AS "turn"` +
              ` WHERE "turn"."conversationId" = "ai_conversation"."id"` +
              ` AND "turn"."teamId" = "ai_conversation"."teamId"` +
              ` AND "turn"."userId" = "ai_conversation"."userId"` +
              ` AND "turn"."question" ILIKE ${sequelize.escape(pattern)})`
          ),
        ],
      });
    }
    const where = { [Op.and]: conditions };

    const { results, pagination } = await paginateQuery(
      ctx,
      (opts) =>
        AIConversation.findAll({
          where,
          order: [
            [Sequelize.literal(`"pinnedAt" IS NULL`), "ASC"],
            ["updatedAt", "DESC"],
            ["id", "DESC"],
          ],
          offset: opts.offset,
          limit: opts.limit,
        }),
      () => AIConversation.count({ where })
    );

    ctx.body = {
      pagination,
      data: results.map((conversation) => presentAIConversation(conversation)),
    };
  }
);

router.post(
  "aiConversations.info",
  rateLimiter(RateLimiterStrategy.OneHundredPerMinute),
  // Session only: API keys and OAuth tokens never reach anyone's chats.
  auth({ type: AuthenticationType.APP }),
  validate(T.AIConversationsInfoSchema),
  async (ctx: APIContext<T.AIConversationsInfoReq>) => {
    const { user } = ctx.state.auth;
    const { id } = ctx.input.body;

    assertHistoryAllowed(user);
    const conversation = await loadOwn(user, id);
    authorize(user, "read", conversation);

    // Each block is re-authorised now, not when it was stored.
    const turns = await presentTurns(user, await findTurns(user, id));
    ctx.body = { data: presentAIConversation(conversation, turns) };
  }
);

router.post(
  "aiConversations.update",
  rateLimiter(RateLimiterStrategy.TwentyFivePerMinute),
  // Session only: API keys and OAuth tokens never reach anyone's chats.
  auth({ type: AuthenticationType.APP }),
  validate(T.AIConversationsUpdateSchema),
  async (ctx: APIContext<T.AIConversationsUpdateReq>) => {
    const { user } = ctx.state.auth;
    const { id, title, pinned } = ctx.input.body;

    assertHistoryAllowed(user);
    const conversation = await loadOwn(user, id);
    authorize(user, "update", conversation);

    if (title !== undefined) {
      conversation.title = conversationTitle(title);
    }
    if (pinned !== undefined && pinned !== !!conversation.pinnedAt) {
      conversation.pinnedAt = pinned ? new Date() : null;
    }
    // Renaming or pinning is not activity: list order and retention stay.
    await conversation.save({ silent: true });

    ctx.body = { data: presentAIConversation(conversation) };
  }
);

router.post(
  "aiConversations.delete",
  rateLimiter(RateLimiterStrategy.TwentyFivePerMinute),
  // Session only: API keys and OAuth tokens never reach anyone's chats.
  auth({ type: AuthenticationType.APP }),
  validate(T.AIConversationsDeleteSchema),
  async (ctx: APIContext<T.AIConversationsDeleteReq>) => {
    const { user } = ctx.state.auth;
    const { id } = ctx.input.body;

    // Not gated on the preferences or role: owners can always delete what
    // was stored.
    const conversation = await loadOwn(user, id);
    authorize(user, "delete", conversation);

    // Hard delete; the turns go with it (foreign key cascade).
    await AIConversation.destroy({
      where: { id, teamId: user.teamId, userId: user.id },
    });
    // Best effort: the hot cache also expires on its own within the hour.
    await deleteConversation(user, id);

    ctx.body = { success: true };
  }
);

export default router;
