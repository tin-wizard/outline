import { Op } from "sequelize";
import {
  AIAnswerUsage,
  AIConversation,
  ApiKey,
  GroupUser,
  OAuthAuthentication,
  Star,
  Subscription,
  UserAuthentication,
  UserMembership,
  WebhookSubscription,
} from "@server/models";
import { sequelize } from "@server/storage/database";
import type { Event as TEvent, UserEvent } from "@server/types";
import BaseProcessor from "./BaseProcessor";

export default class UserDeletedProcessor extends BaseProcessor {
  static applicableEvents: TEvent["name"][] = ["users.delete"];

  async perform(event: UserEvent) {
    await sequelize.transaction(async (transaction) => {
      await GroupUser.destroy({
        where: {
          userId: event.userId,
        },
        transaction,
        individualHooks: true,
      });
      await UserAuthentication.destroy({
        where: {
          userId: event.userId,
        },
        transaction,
      });
      await UserMembership.destroy({
        where: {
          userId: event.userId,
        },
        transaction,
      });
      await Subscription.destroy({
        where: {
          userId: event.userId,
        },
        transaction,
      });
      await ApiKey.destroy({
        where: {
          userId: event.userId,
        },
        transaction,
      });
      await OAuthAuthentication.destroy({
        where: {
          userId: event.userId,
        },
        transaction,
      });
      await Star.destroy({
        where: {
          userId: event.userId,
        },
        transaction,
      });
      // Hard delete; turns go with it (foreign key cascade).
      await AIConversation.destroy({
        where: {
          userId: event.userId,
          teamId: event.teamId,
        },
        transaction,
      });
      // Usage rows stay (billing metadata); only the free-text comment goes.
      await AIAnswerUsage.update(
        { feedbackComment: null },
        {
          where: {
            userId: event.userId,
            teamId: event.teamId,
            feedbackComment: { [Op.ne]: null },
          },
          transaction,
        }
      );
      await WebhookSubscription.update(
        { enabled: false },
        {
          where: {
            createdById: event.userId,
            enabled: true,
          },
          transaction,
        }
      );
    });
  }
}
