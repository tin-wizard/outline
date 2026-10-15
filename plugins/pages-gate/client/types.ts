import type { PagesGateType } from "../shared/accessCode";

export type SiteStatus = "draft" | "published" | "unpublished";

/** A gated site as presented by the pages API. */
export interface PagesSiteData {
  id: string;
  slug: string;
  title: string;
  status: SiteStatus;
  /** "code" when readers need an access code, "none" for plain pages. */
  gateType: PagesGateType;
  measurementEnabled: boolean;
  publishedUrl: string | null;
  pages: { pageKey: string; title: string; publishedAt: string | null }[];
  domains: { hostname: string }[];
  updatedAt: string;
}

/** The response of pages.publish and pages.rotate. */
export interface PublishResult {
  site: PagesSiteData;
  publishedUrl: string | null;
  pageCount: number;
  warnings: string[];
  /**
   * Present only when the first publish or a rotation generated the code. A
   * one-time secret.
   */
  accessCode?: string;
}

/** A document or collection chosen to publish. */
export interface SourceChoice {
  type: "document" | "collection";
  id: string;
  title: string;
}

/** One period of the insights series. */
export interface InsightsSeriesPoint {
  date: string;
  views: number;
  visitors: number;
  activeSeconds: number;
}

/** The response of pages.insights. Anonymous aggregates only. */
export interface InsightsData {
  period: "day" | "week";
  from: string;
  to: string;
  measurementEnabled: boolean;
  retentionDays: number;
  totals: {
    views: number;
    visitors: number;
    visitorsApproximate: boolean;
    activeSeconds: number;
    averageSeconds: number;
    medianSeconds: number;
    medianApproximate: boolean;
  };
  series: InsightsSeriesPoint[];
  pages: {
    pageKey: string;
    title: string;
    views: number;
    visitors: number;
    averageSeconds: number;
  }[];
}
