import { PagesDomain, PagesPublication, type PagesSite } from "@server/models";
import { PagesSiteStatus } from "@server/models/PagesSite";
import pagesEnv from "../env";

/**
 * The associations presentPagesSite needs, for use in a find's `include`.
 *
 * @returns the include options.
 */
export function pagesSiteIncludes() {
  return [
    { model: PagesDomain, as: "domains", separate: true },
    {
      model: PagesPublication,
      as: "publications",
      separate: true,
      attributes: ["id", "siteId", "pageKey", "title", "publishedAt"],
    },
  ];
}

/**
 * The public address of a site's entry page.
 *
 * @param site the site.
 * @returns the URL, or null unless the site is published.
 */
export function publishedUrl(site: PagesSite): string | null {
  const base = pagesEnv.PAGES_PUBLIC_BASE_URL;
  if (site.status !== PagesSiteStatus.Published || !base) {
    return null;
  }
  return `${base.replace(/\/+$/, "")}/sites/${site.slug}/index.html`;
}

/**
 * Presents a gated site for the admin API. The associations from
 * pagesSiteIncludes should be loaded; missing ones present as empty.
 *
 * @param site the site, with its domains and publications loaded.
 * @returns the API representation, which holds nothing secret.
 */
export function presentPagesSite(site: PagesSite) {
  return {
    id: site.id,
    slug: site.slug,
    title: site.title,
    status: site.status,
    gateType: site.gateType,
    currentVersion: site.currentVersion,
    codeVersion: site.codeVersion,
    rotatedAt: site.rotatedAt,
    measurementEnabled: site.measurementEnabled,
    ingestKey: site.ingestKey,
    publishedUrl: publishedUrl(site),
    pages: (site.publications ?? [])
      .map((publication) => ({
        pageKey: publication.pageKey,
        // Falls back to the key, as Insights does, for a row without a title.
        title: publication.title ?? publication.pageKey,
        publishedAt: publication.publishedAt,
      }))
      .sort((a, b) => a.pageKey.localeCompare(b.pageKey)),
    domains: (site.domains ?? []).map((domain) => ({
      hostname: domain.hostname,
      verificationStatus: domain.verificationStatus,
      certificateStatus: domain.certificateStatus,
    })),
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  };
}
