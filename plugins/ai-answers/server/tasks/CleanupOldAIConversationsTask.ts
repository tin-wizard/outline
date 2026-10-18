import { subDays } from "date-fns";
import { Op } from "sequelize";
import Logger from "@server/logging/Logger";
import { AIConversation } from "@server/models";
import { TaskPriority } from "@server/queues/tasks/base/BaseTask";
import type { Props } from "@server/queues/tasks/base/CronTask";
import { CronTask, TaskInterval } from "@server/queues/tasks/base/CronTask";
import { sequelizeReadOnly } from "@server/storage/database";
import { Hour } from "@shared/utils/time";
import { retentionDays } from "../history";

/**
 * Deletes stored AI conversations, with their turns, whose last activity is
 * older than the retention period (`AI_HISTORY_RETENTION_DAYS`, default 90).
 */
export default class CleanupOldAIConversationsTask extends CronTask {
  public async perform({ partition }: Props) {
    const cutoffDate = subDays(new Date(), retentionDays());
    let totalConversationsDeleted = 0;

    try {
      await sequelizeReadOnly.transaction(async (transaction) =>
        AIConversation.findAllInBatches(
          {
            attributes: ["id"],
            where: {
              updatedAt: { [Op.lt]: cutoffDate },
              ...this.getPartitionWhereClause("id", partition),
            },
            batchLimit: 1000,
            totalLimit: 100000,
            order: [["updatedAt", "ASC"]],
            transaction,
          },
          async (conversations) => {
            // Turns are removed by the foreign key cascade.
            totalConversationsDeleted += await AIConversation.destroy({
              where: { id: { [Op.in]: conversations.map((c) => c.id) } },
            });
          }
        )
      );
    } finally {
      if (totalConversationsDeleted > 0) {
        Logger.info("task", "Deleted old AI conversations", {
          totalConversationsDeleted,
        });
      }
    }
  }

  public get cron() {
    return {
      interval: TaskInterval.Day,
      partitionWindow: Hour.ms,
    };
  }

  public get options() {
    return {
      attempts: 1,
      priority: TaskPriority.Background,
    };
  }
}
