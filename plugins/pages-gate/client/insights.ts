import type { InsightsData, InsightsSeriesPoint, SiteStatus } from "./types";

/**
 * Formats a duration as `m:ss`, or `h:mm:ss` from one hour.
 *
 * @param seconds the duration; fractions are rounded, bad input is 0.
 * @returns the formatted duration.
 */
export function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The smallest bar, as a share of the tallest, for a non-zero value. */
const MIN_RATIO = 0.02;

/**
 * Scales a series of views to bar heights between 0 and 1. Zero stays zero
 * and any other value keeps a visible sliver.
 *
 * @param series the insights series.
 * @returns one entry per period with its views and a height ratio.
 */
export function normaliseSeries(series: InsightsSeriesPoint[]) {
  const max = Math.max(0, ...series.map((p) => p.views));
  return series.map(({ date, views }) => ({
    date,
    views,
    ratio: max === 0 || views === 0 ? 0 : Math.max(MIN_RATIO, views / max),
  }));
}

/** What the insights dialog should show. */
export type InsightsViewState =
  | "never-published"
  | "measurement-off"
  | "no-data"
  | "data";

/**
 * Decides which state of the dialog applies.
 *
 * @param site the site's status.
 * @param data the loaded insights.
 * @returns the state. History is shown whenever it exists, even when
 * measurement has since been switched off.
 */
export function insightsViewState(
  site: { status: SiteStatus },
  data: Pick<InsightsData, "measurementEnabled"> & {
    totals: Pick<InsightsData["totals"], "views">;
  }
): InsightsViewState {
  if (site.status === "draft") {
    return "never-published";
  }
  if (data.totals.views > 0) {
    return "data";
  }
  return data.measurementEnabled ? "no-data" : "measurement-off";
}

/**
 * The public address of a page, from the site's entry address.
 *
 * @param entryUrl the published entry address, or null when not published.
 * @param pageKey the page key from the insights.
 * @returns the address, or null when it is unknown or would leave the site.
 */
export function pageLink(
  entryUrl: string | null,
  pageKey: string
): string | null {
  if (!entryUrl) {
    return null;
  }
  try {
    const base = new URL(entryUrl);
    const directory = base.pathname.slice(
      0,
      base.pathname.lastIndexOf("/") + 1
    );
    const resolved = new URL(pageKey, base);
    if (
      resolved.origin !== base.origin ||
      !resolved.pathname.startsWith(directory)
    ) {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

/** The dialog's options and the state of the request they drive. */
export interface InsightsLoadState {
  days: 7 | 30 | 90;
  period: "day" | "week";
  /** Bumped by a retry so the same options are fetched again. */
  reload: number;
  status: "loading" | "ready" | "error";
  data: InsightsData | null;
}

export type InsightsLoadAction =
  | { type: "choose"; days?: 7 | 30 | 90; period?: "day" | "week" }
  | { type: "retry" }
  | { type: "loaded"; data: InsightsData }
  | { type: "failed" };

/**
 * State transitions of the insights dialog. Choosing the value that is
 * already selected changes nothing, so no request is left waiting for an
 * option change that never comes; a different value clears the result and
 * (as days or period changed) triggers a fetch; a retry refetches the same
 * options by bumping `reload`.
 *
 * @param state the current state.
 * @param action what happened.
 * @returns the next state, the same object when nothing changes.
 */
export function insightsLoadReducer(
  state: InsightsLoadState,
  action: InsightsLoadAction
): InsightsLoadState {
  switch (action.type) {
    case "choose": {
      const days = action.days ?? state.days;
      const period = action.period ?? state.period;
      if (days === state.days && period === state.period) {
        return state;
      }
      return { ...state, days, period, status: "loading", data: null };
    }
    case "retry":
      return state.status === "error"
        ? { ...state, reload: state.reload + 1, status: "loading", data: null }
        : state;
    case "loaded":
      return { ...state, status: "ready", data: action.data };
    case "failed":
      return { ...state, status: "error", data: null };
  }
}
