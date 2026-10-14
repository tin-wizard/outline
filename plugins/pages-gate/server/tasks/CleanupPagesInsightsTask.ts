import { QueryTypes } from "sequelize";
import { Minute } from "@shared/utils/time";
import Logger from "@server/logging/Logger";
import { TaskPriority } from "@server/queues/tasks/base/BaseTask";
import type { Props } from "@server/queues/tasks/base/CronTask";
import { CronTask, TaskInterval } from "@server/queues/tasks/base/CronTask";
import { sequelize } from "@server/storage/database";
import env from "../env";

/** Days of rollup history to retain. */
const INSIGHT_RETENTION_DAYS = 365;

const DEFAULT_BATCH_SIZE = 10000;

/**
 * Deletes raw view events past the retention window and expired rollups.
 */
export default class CleanupPagesInsightsTask extends CronTask {
  public async perform({ limit }: Props) {
    const batchSize = limit > 0 ? limit : DEFAULT_BATCH_SIZE;

    // Cutoffs come from the database clock; `NOW()` is an absolute instant and
    // `date` is a UTC DATE, so the worker's time zone does not matter.
    const events = await deleteInBatches(
      `
      DELETE FROM pages_view_events
      WHERE id IN (
        SELECT id FROM pages_view_events
        WHERE "startedAt" < NOW() - (:days::int * INTERVAL '1 day')
        LIMIT :batchSize
      )
      `,
      { days: env.PAGES_EVENT_RETENTION_DAYS, batchSize }
    );
    const insights = await deleteInBatches(
      `
      DELETE FROM pages_insights
      WHERE id IN (
        SELECT id FROM pages_insights
        WHERE date < (NOW() AT TIME ZONE 'UTC')::date - (:days::int * INTERVAL '1 day')
        LIMIT :batchSize
      )
      `,
      { days: INSIGHT_RETENTION_DAYS, batchSize }
    );

    Logger.info("task", "Cleaned up pages insights", { events, insights });
  }

  public get cron() {
    return {
      interval: TaskInterval.Day,
      partitionWindow: 30 * Minute.ms,
    };
  }

  public get options() {
    return {
      attempts: 1,
      priority: TaskPriority.Background,
    };
  }
}

/**
 * Runs a bounded DELETE repeatedly until a batch comes back short. Each
 * statement removes at most `batchSize` rows, so the loop ends once the
 * backlog is drained.
 */
async function deleteInBatches(
  sql: string,
  replacements: { days: number; batchSize: number }
): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await sequelize.query(sql, {
      replacements,
      type: QueryTypes.BULKDELETE,
    });
    total += deleted;
    if (deleted < replacements.batchSize) {
      return total;
    }
  }
}
