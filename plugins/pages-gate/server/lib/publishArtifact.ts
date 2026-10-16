import { randomBytes } from "node:crypto";
import { UniqueConstraintError } from "sequelize";
import { ValidationError } from "@server/errors";
import { PagesSite, type User } from "@server/models";
import { PagesSiteKind, PagesSiteStatus } from "@server/models/PagesSite";
import { authorize } from "@server/policies";
import { PagesGateType } from "../../shared/accessCode";
import type { StoreFactory } from "../api/publish";
import "../policies";
import { BundleError, readBundle } from "./artifactBundle";
import { assertSafePath } from "./artifactPaths";
import { artifactPrefix, createArtifactStore } from "./artifactStore";
import { InvalidSlugError, assertValidSlug } from "./keys";

/** What `publishArtifact` needs; the caller has already checked access to the upload's source. */
export interface PublishArtifactInput {
  user: User;
  /** Optional chosen address; a random unguessable one is generated when omitted. */
  slug?: string;
  title?: string;
  /** The name used to detect html vs zip and to derive a default title, e.g. "demo.html". */
  fileName: string;
  /** Called only AFTER every authorization check has passed; returns the upload bytes. */
  readBytes: () => Promise<Buffer>;
  storeFactory: StoreFactory;
}

/**
 * Publishes one HTML file or a zip of a static site to the public bucket
 * under `artifacts/<slug>/`, creating the artifact site or republishing it.
 *
 * @param input the acting user, address, upload and store.
 * @returns the published site and the number of files written.
 * @throws AuthorizationError when the user is not a Pages admin or may not publish the site.
 * @throws ValidationError for an invalid or taken address or an invalid bundle.
 */
export async function publishArtifact(
  input: PublishArtifactInput
): Promise<{ site: PagesSite; fileCount: number }> {
  const { user, slug, title, fileName, readBytes, storeFactory } = input;

  // Before any slug check or lookup, so a non-admin cannot probe which are taken.
  authorize(user, "createPagesSite", user.team);

  if (slug !== undefined) {
    try {
      assertValidSlug(slug);
    } catch (err) {
      if (err instanceof InvalidSlugError) {
        throw ValidationError(`Invalid address: ${err.reason}`);
      }
      throw err;
    }
  }

  // A site that exists but is not ours (another team, or a pages site)
  // gets the same message as a taken one, so nothing about it leaks.
  let site = slug ? await PagesSite.findOne({ where: { slug } }) : null;
  if (
    site &&
    (site.teamId !== user.teamId || site.kind !== PagesSiteKind.Artifact)
  ) {
    throw ValidationError(TAKEN);
  }
  if (site) {
    authorize(user, "publish", site);
  }

  const bytes = await readBytes();
  let bundle: Awaited<ReturnType<typeof readBundle>>;
  try {
    bundle = await readBundle(fileName, bytes);
  } catch (err) {
    if (err instanceof BundleError) {
      throw ValidationError(err.message);
    }
    throw err;
  }

  if (!site) {
    const newSlug = slug ?? randomBytes(8).toString("hex");
    try {
      // Draft first: if the upload below fails the row is visible and
      // deletable, and never claims to be published.
      site = await PagesSite.create({
        teamId: user.teamId,
        createdById: user.id,
        slug: newSlug,
        // A bare ".html" leaves nothing after the extension; never store "".
        title: title ?? (fileName.replace(/\.(html?|zip)$/i, "") || fileName),
        kind: PagesSiteKind.Artifact,
        gateType: PagesGateType.None,
        prefix: artifactPrefix(newSlug),
        status: PagesSiteStatus.Draft,
      });
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw ValidationError(TAKEN);
      }
      throw err;
    }
  }

  const files = createArtifactStore(await storeFactory(), site.slug);
  const keep = new Set(bundle.files.map((file) => file.path));
  // "" is a folder marker at the prefix. Every other leftover is checked
  // before anything is written, so a bad name never leaves a half-publish.
  const stale = (await files.list()).filter(
    (path) => path !== "" && !keep.has(path)
  );
  for (const path of stale) {
    try {
      assertSafePath(path);
    } catch {
      throw new Error(
        "Artifact has files with unsafe names; remove them manually"
      );
    }
  }
  for (const file of bundle.files) {
    await files.put(file.path, file.body, {
      contentType: file.contentType,
      // Short, so a republish shows up within minutes.
      cacheControl: "public, max-age=300",
    });
  }
  for (const path of stale) {
    await files.delete(path);
  }

  await site.update({
    status: PagesSiteStatus.Published,
    title: title ?? site.title,
    currentVersion: site.currentVersion + 1,
  });

  return { site, fileCount: bundle.files.length };
}

const TAKEN = "That address is already taken";
