import { Op, QueryTypes } from "sequelize";
import { Day } from "@shared/utils/time";
import { PagesInsight, PagesPublication } from "@server/models";
import { sequelize } from "@server/storage/database";
import { RECOMPUTE_DAYS, RECOMPUTE_PREVIOUS_WEEKS } from "./rollupWindow";

/** Time-on-page buckets, matching the keys the rollup task writes. */
const BUCKETS = [
  { key: "0-9", lower: 0, upper: 10 },
  { key: "10-29", lower: 10, upper: 30 },
  { key: "30-59", lower: 30, upper: 60 },
  { key: "60-179", lower: 60, upper: 180 },
  { key: "180-599", lower: 180, upper: 600 },
  // Open ended: interpolated as if it ended at the cap.
  { key: "600+", lower: 600, upper: 1800 },
] as const;

export type InsightsPeriod = "day" | "week";

/** One entry of the series. */
export interface InsightsSeriesPoint {
  date: string;
  views: number;
  visitors: number;
  activeSeconds: number;
}

/** One of the top pages. */
export interface InsightsPage {
  pageKey: string;
  /** The title stored at publish time, or the page key when there is none. */
  title: string;
  views: number;
  visitors: number;
  averageSeconds: number;
}

/** The insights read model returned by the route. */
export interface InsightsResult {
  period: InsightsPeriod;
  from: string;
  to: string;
  totals: {
    views: number;
    visitors: number;
    visitorsApproximate: boolean;
    activeSeconds: number;
    averageSeconds: number;
    medianSeconds: number;
    medianApproximate: true;
  };
  series: InsightsSeriesPoint[];
  pages: InsightsPage[];
}

/**
 * Estimates the median time on page from summed histogram buckets by linear
 * interpolation inside the bucket holding the 50th percentile. The first
 * bucket spans 0 to 10 seconds and the open `600+` bucket is treated as 600 to
 * 1800 seconds, so the result never exceeds 1800.
 *
 * @param histogram counts keyed by bucket name; missing keys count as zero.
 * @returns whole seconds, 0 when there are no views.
 */
export function medianFromHistogram(histogram: Record<string, number>): number {
  const total = BUCKETS.reduce((sum, b) => sum + (histogram[b.key] ?? 0), 0);
  if (total <= 0) {
    return 0;
  }
  const target = total / 2;
  let before = 0;
  for (const { key, lower, upper } of BUCKETS) {
    const count = histogram[key] ?? 0;
    if (count > 0 && before + count >= target) {
      return Math.round(lower + ((target - before) / count) * (upper - lower));
    }
    before += count;
  }
  return 0;
}

interface Range {
  /** Start dates (YYYY-MM-DD) of every period, oldest first. */
  starts: string[];
  /** Start date of the first period still recomputed by the rollup. */
  liveFrom: string;
  /** Exclusive end of the last period, as an instant. */
  end: Date;
  /** Inclusive last day shown, never in the future. */
  to: string;
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Works out the periods of a range in UTC, and which of them the rollup may
 * not have settled yet (those are read from raw events instead).
 *
 * @param now the current time in milliseconds.
 * @param period whether periods are UTC days or Monday-start UTC weeks.
 * @param days the requested range in days; weeks round up.
 * @returns the periods and boundaries.
 */
export function resolveRange(
  now: number,
  period: InsightsPeriod,
  days: number
): Range {
  const today = now - (now % Day.ms);
  const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * Day.ms;
  const step = period === "day" ? Day.ms : 7 * Day.ms;
  const count = period === "day" ? days : Math.ceil(days / 7);
  const last = period === "day" ? today : monday;
  const starts = Array.from({ length: count }, (_, i) =>
    isoDate(last - (count - 1 - i) * step)
  );
  const settledFrom =
    period === "day"
      ? today - RECOMPUTE_DAYS * Day.ms
      : monday - RECOMPUTE_PREVIOUS_WEEKS * 7 * Day.ms;
  return {
    starts,
    liveFrom:
      starts.find((s) => s >= isoDate(settledFrom)) ?? isoDate(last + step),
    end: new Date(last + step),
    to: isoDate(today),
  };
}

type Histogram = Record<string, number>;

interface Aggregate {
  views: number;
  visitors: number;
  seconds: number;
  histogram: Histogram;
}

const num = (value: string | number | null | undefined) => Number(value ?? 0);

/**
 * Reads views, visitors and time on page for a site. Periods the daily rollup
 * has settled come from `pages_insights`; the periods it still recomputes
 * (today and the two days before, this week and the one before) come from raw
 * events. Each period is read from exactly one of them, so nothing is
 * counted twice and today's activity shows up immediately.
 *
 * @param args.siteId the site, already authorized by the caller.
 * @param args.period day or week.
 * @param args.days 7, 30 or 90.
 * @param args.now the current time in milliseconds.
 * @param args.retentionDays configured raw event retention.
 * @returns the totals, series and top pages. Nothing identifies a person.
 */
export async function loadInsights(args: {
  siteId: string;
  period: InsightsPeriod;
  days: number;
  now: number;
  retentionDays: number;
}): Promise<InsightsResult> {
  const { siteId, period, days, now, retentionDays } = args;
  const range = resolveRange(now, period, days);
  const from = range.starts[0];
  const liveFrom = range.liveFrom;
  const base = { siteId, from, liveFrom, end: range.end.toISOString() };

  const periods = new Map<string, Aggregate>();
  const empty = (): Aggregate => ({
    views: 0,
    visitors: 0,
    seconds: 0,
    histogram: {},
  });

  // Settled periods: the site-wide rows (empty page key).
  const stored = await PagesInsight.findAll({
    where: {
      siteId,
      period,
      pageKey: "",
      date: { [Op.gte]: from, [Op.lt]: liveFrom },
    },
  });
  for (const row of stored) {
    periods.set(row.date, {
      views: row.viewCount,
      visitors: row.visitorCount,
      seconds: row.totalActiveSeconds,
      histogram: row.timeHistogram,
    });
  }

  // Merge rule, one source per period: a period is read from its stored
  // site-wide row when it has one, and otherwise from raw events. Raw events
  // are used for (a) every period the rollup still recomputes (>= liveFrom),
  // whose stored row may be stale, and (b) settled periods inside the raw
  // retention window with NO stored row (rollup missed runs, or the events
  // predate the first run: there is no backfill). A period with a stored row
  // is never read from raw events, so nothing is counted twice. The same set
  // is used for the per-page figures below.
  const cutoff = now - retentionDays * Day.ms;
  const rawDates = range.starts.filter(
    (start) =>
      start >= liveFrom ||
      (!periods.has(start) && Date.parse(`${start}T00:00:00Z`) >= cutoff)
  );
  // Starts are ascending, so the first one bounds the raw scan below.
  const rawBase = { ...base, rawFrom: rawDates[0], rawDates };

  // Raw periods, bucketed like the rollup (UTC, Monday weeks).
  const liveRows = await sequelize.query<Record<string, string>>(
    `
      SELECT to_char(date_trunc(:unit, "startedAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
        COUNT(*)::text AS views,
        COUNT(DISTINCT "sessionId")::text AS visitors,
        COALESCE(SUM("activeSeconds"), 0)::text AS seconds,
        COUNT(*) FILTER (WHERE "activeSeconds" < 10)::text AS b0,
        COUNT(*) FILTER (WHERE "activeSeconds" >= 10 AND "activeSeconds" < 30)::text AS b1,
        COUNT(*) FILTER (WHERE "activeSeconds" >= 30 AND "activeSeconds" < 60)::text AS b2,
        COUNT(*) FILTER (WHERE "activeSeconds" >= 60 AND "activeSeconds" < 180)::text AS b3,
        COUNT(*) FILTER (WHERE "activeSeconds" >= 180 AND "activeSeconds" < 600)::text AS b4,
        COUNT(*) FILTER (WHERE "activeSeconds" >= 600)::text AS b5
      FROM pages_view_events
      WHERE "siteId" = :siteId
        AND "startedAt" >= :rawFrom::timestamp AT TIME ZONE 'UTC'
        AND "startedAt" < :end::timestamptz
        AND to_char(date_trunc(:unit, "startedAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') IN (:rawDates)
      GROUP BY 1
      `,
    {
      replacements: { ...rawBase, unit: period },
      type: QueryTypes.SELECT,
    }
  );
  for (const r of liveRows) {
    periods.set(r.date, {
      views: num(r.views),
      visitors: num(r.visitors),
      seconds: num(r.seconds),
      histogram: Object.fromEntries(
        BUCKETS.map(({ key }, i) => [key, num(r[`b${i}`])])
      ),
    });
  }

  const series = range.starts.map((date) => {
    const p = periods.get(date) ?? empty();
    return {
      date,
      views: p.views,
      visitors: p.visitors,
      activeSeconds: p.seconds,
    };
  });

  const histogram: Histogram = {};
  let visitorSum = 0;
  let views = 0;
  let activeSeconds = 0;
  for (const date of range.starts) {
    const p = periods.get(date);
    if (!p) {
      continue;
    }
    views += p.views;
    activeSeconds += p.seconds;
    visitorSum += p.visitors;
    for (const [key, count] of Object.entries(p.histogram)) {
      histogram[key] = (histogram[key] ?? 0) + num(count);
    }
  }

  // Distinct sessions can only be counted from raw events, which exist for
  // the whole range only while it is inside the retention window.
  const exact = Date.parse(`${from}T00:00:00Z`) >= now - retentionDays * Day.ms;
  let visitors = visitorSum;
  if (exact) {
    const [row] = await sequelize.query<{ visitors: string }>(
      `
      SELECT COUNT(DISTINCT "sessionId")::text AS visitors
      FROM pages_view_events
      WHERE "siteId" = :siteId
        AND "startedAt" >= :from::timestamp AT TIME ZONE 'UTC'
        AND "startedAt" < :end::timestamptz
      `,
      { replacements: base, type: QueryTypes.SELECT }
    );
    visitors = num(row?.visitors);
  }

  // Top pages: settled rows summed per page plus the unsettled raw events.
  const pageRows = await sequelize.query<{
    pageKey: string;
    views: string;
    visitors: string;
    seconds: string;
  }>(
    `
    SELECT "pageKey", SUM(views)::text AS views, SUM(visitors)::text AS visitors,
      SUM(seconds)::text AS seconds
    FROM (
      SELECT "pageKey", "viewCount" AS views, "visitorCount" AS visitors,
        "totalActiveSeconds"::bigint AS seconds
      FROM pages_insights
      WHERE "siteId" = :siteId AND period = :period AND "pageKey" <> ''
        AND date >= :from::date AND date < :liveFrom::date
        AND date NOT IN (:rawDates)
      UNION ALL
      SELECT "pageKey", COUNT(*), COUNT(DISTINCT "sessionId"),
        COALESCE(SUM("activeSeconds"), 0)
      FROM pages_view_events
      WHERE "siteId" = :siteId
        AND "startedAt" >= :rawFrom::timestamp AT TIME ZONE 'UTC'
        AND "startedAt" < :end::timestamptz
        AND to_char(date_trunc(:unit, "startedAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') IN (:rawDates)
      GROUP BY "pageKey"
    ) u
    GROUP BY "pageKey"
    ORDER BY SUM(views) DESC, "pageKey" ASC
    LIMIT 20
    `,
    {
      replacements: { ...rawBase, period, unit: period },
      type: QueryTypes.SELECT,
    }
  );

  const pageVisitors = new Map<string, number>();
  if (exact && pageRows.length > 0) {
    const distinct = await sequelize.query<{
      pageKey: string;
      visitors: string;
    }>(
      `
      SELECT "pageKey", COUNT(DISTINCT "sessionId")::text AS visitors
      FROM pages_view_events
      WHERE "siteId" = :siteId
        AND "pageKey" IN (:pageKeys)
        AND "startedAt" >= :from::timestamp AT TIME ZONE 'UTC'
        AND "startedAt" < :end::timestamptz
      GROUP BY "pageKey"
      `,
      {
        replacements: { ...base, pageKeys: pageRows.map((r) => r.pageKey) },
        type: QueryTypes.SELECT,
      }
    );
    for (const row of distinct) {
      pageVisitors.set(row.pageKey, num(row.visitors));
    }
  }

  // Titles live on the publication rows only; a page since removed or
  // published without one shows its key.
  const titles = new Map<string, string>();
  if (pageRows.length > 0) {
    const publications = await PagesPublication.findAll({
      attributes: ["pageKey", "title"],
      where: { siteId, pageKey: pageRows.map((r) => r.pageKey) },
    });
    for (const publication of publications) {
      if (publication.title) {
        titles.set(publication.pageKey, publication.title);
      }
    }
  }

  return {
    period,
    from,
    to: range.to,
    totals: {
      views,
      visitors,
      visitorsApproximate: !exact,
      activeSeconds,
      averageSeconds: views > 0 ? Math.round(activeSeconds / views) : 0,
      medianSeconds: medianFromHistogram(histogram),
      medianApproximate: true,
    },
    series,
    pages: pageRows.map((r) => {
      const pageViews = num(r.views);
      return {
        pageKey: r.pageKey,
        title: titles.get(r.pageKey) ?? r.pageKey,
        views: pageViews,
        visitors: pageVisitors.get(r.pageKey) ?? num(r.visitors),
        averageSeconds:
          pageViews > 0 ? Math.round(num(r.seconds) / pageViews) : 0,
      };
    }),
  };
}
