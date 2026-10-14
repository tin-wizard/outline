import { client } from "~/utils/ApiClient";
import type {
  InsightsData,
  PagesSiteData,
  PublishResult,
  SourceChoice,
} from "./types";

const PAGE_SIZE = 100;

/**
 * Options for the calls that write a whole site. A retried publish fails with
 * access_code_required or rotates again, and a retried rotation issues
 * another code, so the one-time code of the first attempt would be lost.
 */
export const NO_RETRY = { retry: false } as const;

/**
 * Loads every gated site of the team, newest first.
 *
 * @returns the sites.
 */
export async function listSites(): Promise<PagesSiteData[]> {
  const sites: PagesSiteData[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await client.post("/pages.list", { offset, limit: PAGE_SIZE });
    const page: PagesSiteData[] = res.data ?? [];
    sites.push(...page);
    if (page.length < PAGE_SIZE) {
      return sites;
    }
  }
}

/**
 * Creates a draft site.
 *
 * @param input the site fields; hostname is omitted when blank.
 * @returns the created site.
 */
export async function createSite(input: {
  slug: string;
  title: string;
  measurementEnabled: boolean;
  hostname?: string;
}): Promise<PagesSiteData> {
  const res = await client.post("/pages.create", input);
  return res.data;
}

function toRequestSources(sources: SourceChoice[]) {
  return sources.length > 0
    ? sources.map(({ type, id }) => ({ type, id }))
    : undefined;
}

/**
 * Publishes a site. The response may hold the one-time access code: callers
 * keep it in component state only.
 *
 * @param input the site, the chosen sources (empty reuses the stored ones) and
 * the current access code when republishing.
 * @returns the publish result.
 */
export async function publishSite(input: {
  id: string;
  sources: SourceChoice[];
  accessCode?: string;
}): Promise<PublishResult> {
  const res = await client.post(
    "/pages.publish",
    {
      id: input.id,
      sources: toRequestSources(input.sources),
      accessCode: input.accessCode || undefined,
    },
    NO_RETRY
  );
  return res.data;
}

/**
 * Replaces the access code. The response holds the new one-time code.
 *
 * @param input the site and the chosen sources (empty reuses the stored ones).
 * @returns the publish result.
 */
export async function rotateSite(input: {
  id: string;
  sources: SourceChoice[];
}): Promise<PublishResult> {
  const res = await client.post(
    "/pages.rotate",
    { id: input.id, sources: toRequestSources(input.sources) },
    NO_RETRY
  );
  return res.data;
}

/**
 * Takes a site offline.
 *
 * @param id the site id.
 */
export async function unpublishSite(id: string): Promise<void> {
  await client.post("/pages.unpublish", { id }, NO_RETRY);
}

/**
 * Deletes a site and its published files.
 *
 * @param id the site id.
 */
export async function deleteSite(id: string): Promise<void> {
  await client.post("/pages.delete", { id }, NO_RETRY);
}

/**
 * Loads views, visitors and time on page for a site.
 *
 * @param input the site, the period grouping and the range in days.
 * @returns the anonymous aggregates.
 */
export async function loadInsights(input: {
  id: string;
  period: "day" | "week";
  days: 7 | 30 | 90;
}): Promise<InsightsData> {
  const res = await client.post("/pages.insights", input);
  return res.data;
}
