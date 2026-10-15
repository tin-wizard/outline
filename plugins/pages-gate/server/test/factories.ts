import { PagesSite, PagesViewEvent } from "@server/models";
import { buildTeam, buildUser } from "@server/test/factories";
import { randomString } from "@shared/random";

/**
 * Builds a draft pages site with its own team and creator.
 *
 * @param overrides attributes to override on the site.
 * @returns the created site.
 */
export async function buildPagesSite(overrides: Partial<PagesSite> = {}) {
  const slug = overrides.slug ?? `site-${randomString(8).toLowerCase()}`;
  const teamId = overrides.teamId ?? (await buildTeam()).id;
  const createdById = overrides.createdById ?? (await buildUser({ teamId })).id;
  return PagesSite.create({
    title: "Test site",
    prefix: `sites/${slug}/`,
    createdById,
    ...overrides,
    teamId,
    slug,
  });
}

/**
 * Builds one page view event. A site is created when `siteId` is not given.
 *
 * @param overrides attributes to override on the event.
 * @returns the created event.
 */
export async function buildPagesViewEvent(
  overrides: Partial<PagesViewEvent> = {}
) {
  const siteId = overrides.siteId ?? (await buildPagesSite()).id;
  const startedAt = overrides.startedAt ?? new Date();
  return PagesViewEvent.create({
    pageKey: "/",
    sessionId: randomString(16),
    lastSeenAt: startedAt,
    activeSeconds: 0,
    ...overrides,
    siteId,
    startedAt,
  });
}
