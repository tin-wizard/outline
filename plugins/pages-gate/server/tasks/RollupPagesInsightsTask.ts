import { QueryTypes } from "sequelize";
import { Day, Minute } from "@shared/utils/time";
import Logger from "@server/logging/Logger";
import { TaskPriority } from "@server/queues/tasks/base/BaseTask";
import type { Props } from "@server/queues/tasks/base/CronTask";
import { CronTask, TaskInterval } from "@server/queues/tasks/base/CronTask";
import { sequelize } from "@server/storage/database";
import { RECOMPUTE_DAYS } from "../lib/rollupWindow";

/**
 * Recomputes daily and weekly pages_insights rows from raw view events.
 */
export default class RollupPagesInsightsTask extends CronTask {
  public async perform({ partition }: Props) {
    const [startUuid, endUuid] = this.getPartitionBounds(partition);
    const today = utcMidnight(Date.now());
    const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * Day.ms;

    const periods: { start: number; days: number; period: string }[] = [];
    for (let offset = RECOMPUTE_DAYS; offset >= 0; offset--) {
      periods.push({ start: today - offset * Day.ms, days: 1, period: "day" });
    }
    periods.push({ start: monday - 7 * Day.ms, days: 7, period: "week" });
    periods.push({ start: monday, days: 7, period: "week" });

    for (const { start, days, period } of periods) {
      const periodStart = new Date(start).toISOString().slice(0, 10);
      const upserted = await rollupPeriod({
        periodStart,
        intervalDays: days,
        period,
        startUuid,
        endUuid,
      });

      Logger.info("task", `Rolled up pages insights ${period} ${periodStart}`, {
        upserted,
      });
    }
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

function utcMidnight(ms: number) {
  return ms - (ms % Day.ms);
}

/**
 * Upserts the per page and site-wide rows for one UTC period in a single
 * statement. Recomputed from raw events, so it is safe to repeat and to run
 * concurrently: rows are written in a fixed order to avoid lock cycles.
 */
async function rollupPeriod(replacements: {
  periodStart: string;
  intervalDays: number;
  period: string;
  startUuid: string;
  endUuid: string;
}): Promise<number> {
  const [{ upserted }] = await sequelize.query<{ upserted: string }>(
    `
    WITH events AS (
      SELECT "siteId", "pageKey", "sessionId", "activeSeconds"
      FROM pages_view_events
      WHERE "siteId" >= :startUuid::uuid
        AND "siteId" <= :endUuid::uuid
        AND "startedAt" >= :periodStart::timestamp AT TIME ZONE 'UTC'
        AND "startedAt" < (:periodStart::timestamp + (:intervalDays * INTERVAL '1 day')) AT TIME ZONE 'UTC'
    ),
    per_page AS (
      SELECT "siteId", "pageKey",
        COUNT(*) AS views,
        COUNT(DISTINCT "sessionId") AS visitors,
        SUM("activeSeconds") AS seconds,
        jsonb_build_object(
          '0-9', COUNT(*) FILTER (WHERE "activeSeconds" < 10),
          '10-29', COUNT(*) FILTER (WHERE "activeSeconds" >= 10 AND "activeSeconds" < 30),
          '30-59', COUNT(*) FILTER (WHERE "activeSeconds" >= 30 AND "activeSeconds" < 60),
          '60-179', COUNT(*) FILTER (WHERE "activeSeconds" >= 60 AND "activeSeconds" < 180),
          '180-599', COUNT(*) FILTER (WHERE "activeSeconds" >= 180 AND "activeSeconds" < 600),
          '600+', COUNT(*) FILTER (WHERE "activeSeconds" >= 600)
        ) AS histogram
      FROM events
      GROUP BY "siteId", "pageKey"
    ),
    site_wide AS (
      SELECT "siteId", ''::varchar AS "pageKey",
        COUNT(*) AS views,
        COUNT(DISTINCT "sessionId") AS visitors,
        SUM("activeSeconds") AS seconds,
        jsonb_build_object(
          '0-9', COUNT(*) FILTER (WHERE "activeSeconds" < 10),
          '10-29', COUNT(*) FILTER (WHERE "activeSeconds" >= 10 AND "activeSeconds" < 30),
          '30-59', COUNT(*) FILTER (WHERE "activeSeconds" >= 30 AND "activeSeconds" < 60),
          '60-179', COUNT(*) FILTER (WHERE "activeSeconds" >= 60 AND "activeSeconds" < 180),
          '180-599', COUNT(*) FILTER (WHERE "activeSeconds" >= 180 AND "activeSeconds" < 600),
          '600+', COUNT(*) FILTER (WHERE "activeSeconds" >= 600)
        ) AS histogram
      FROM events
      GROUP BY "siteId"
    ),
    upserted AS (
      INSERT INTO pages_insights (
        id, "siteId", "pageKey", date, period,
        "viewCount", "visitorCount", "totalActiveSeconds", "timeHistogram",
        "createdAt", "updatedAt"
      )
      SELECT
        uuid_generate_v4(), r."siteId", r."pageKey", :periodStart::date, :period,
        r.views, r.visitors, LEAST(r.seconds, 2147483647), r.histogram,
        NOW(), NOW()
      FROM (
        SELECT * FROM per_page
        UNION ALL
        SELECT * FROM site_wide
      ) r
      ORDER BY r."siteId", r."pageKey"
      ON CONFLICT ("siteId", "pageKey", date, period) DO UPDATE SET
        "viewCount" = EXCLUDED."viewCount",
        "visitorCount" = EXCLUDED."visitorCount",
        "totalActiveSeconds" = EXCLUDED."totalActiveSeconds",
        "timeHistogram" = EXCLUDED."timeHistogram",
        "updatedAt" = NOW()
      RETURNING 1
    )
    SELECT COUNT(*)::text AS upserted FROM upserted
    `,
    { replacements, type: QueryTypes.SELECT }
  );

  return parseInt(upserted, 10);
}
