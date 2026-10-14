import crypto from "node:crypto";
import { Op, type Transaction } from "sequelize";
import Logger from "@server/logging/Logger";
import { PagesPublication, PagesSite } from "@server/models";
import { PagesSourceType } from "@server/models/PagesPublication";
import { PagesSiteStatus } from "@server/models/PagesSite";
import { sequelize } from "@server/storage/database";
import {
  type Gate,
  createGate,
  generateAccessCode,
  parseGatePage,
  renderGatePage,
  verifyCode,
} from "./gate";
import { InvalidPageKeyError, assertValidPageKey, sitePrefix } from "./keys";
import { type ObjectStore, createGuardedStore } from "./objectStore";
import { INDEX_PAGE_KEY } from "./pageKeys";
import type { RenderedPage } from "./renderPages";

/** What to publish, where, and as whom. */
export interface PublishInput {
  /** The site to publish; its row is re-read under a lock. */
  site: PagesSite;
  /** The rendered plaintext pages; exactly one must be `index.html`. */
  pages: RenderedPage[];
  /** The raw store; it is wrapped in the site's guarded store internally. */
  store: ObjectStore;
  /** The current access code; required on every publish after the first. */
  code?: string;
  /**
   * Replaces the access code: a new code and salt are issued and `code` is
   * ignored. Only valid for a site with a live index.
   */
  rotate?: boolean;
  /** The user publishing. */
  actorId: string;
  /** Optional transform of each page's plaintext HTML before encryption. */
  decoratePage?: (
    html: string,
    context: { pageKey: string; site: PagesSite }
  ) => string;
  /**
   * Test seam only: awaited after the publish commits and before stale
   * objects are cleaned up. Production callers leave it unset.
   */
  onCommitted?: () => Promise<void>;
}

/** The outcome of a successful publish. */
export interface PublishResult {
  /** The object key of the site's entry page. */
  indexKey: string;
  /** Every object key written by this publish. */
  publishedKeys: string[];
  /** Stale object keys removed after the publish committed. */
  removedKeys: string[];
  /** Fixed, non-secret notes about cleanup problems. */
  warnings: string[];
  /** The site's new currentVersion. */
  version: number;
  /** The new access code; present only on the first publish and on rotation. */
  issuedCode?: string;
}

/** Thrown when a republish is attempted without the current access code. */
export class AccessCodeRequiredError extends Error {
  constructor() {
    super("The current access code is required to republish this site");
    this.name = "AccessCodeRequiredError";
  }
}

/** Thrown when the supplied access code does not open the live site. */
export class IncorrectCodeError extends Error {
  constructor() {
    super("The access code does not match the live site");
    this.name = "IncorrectCodeError";
  }
}

/** Thrown when the live entry page cannot be read to reuse its gate. */
export class NoLivePageError extends Error {
  constructor() {
    super(
      "The live site could not be read; rotate the access code to publish again"
    );
    this.name = "NoLivePageError";
  }
}

/** Thrown when rotating a site that has no live code or index to replace. */
export class NothingToRotateError extends Error {
  constructor() {
    super("The site has no published access code to rotate");
    this.name = "NothingToRotateError";
  }
}

/** Thrown when a publish has no pages, so a live site is never wiped. */
export class EmptySiteError extends Error {
  constructor() {
    super("A site cannot be published without pages");
    this.name = "EmptySiteError";
  }
}

/**
 * Encrypts and uploads a site's pages and records the publication. The site
 * row is locked for the whole publish so publishes of one site serialise. On
 * the first publish a new access code is generated and returned once; it is
 * never stored, logged or put in an error. With `rotate`, a new code and salt
 * replace the live ones in the same pipeline and the new code is returned once.
 *
 * Pages other than the index are uploaded first and the index last, inside
 * the transaction after the database writes. If anything fails before the
 * index upload, the database rolls back and the live index still carries the
 * old code and salt, but the site is partly republished: some pages already
 * hold the new content (and, for a rotation, the new code) and readers may
 * meet pages they cannot open until a retry, which issues another fresh code.
 * If the COMMIT itself fails after the index upload, the live index holds a
 * code nobody received: for a rotation, readers are locked out until another
 * rotation succeeds.
 *
 * @param input the site, pages, store, code and actor.
 * @returns the published keys, cleanup outcome, new version and, on first
 * publish only, the issued code.
 * @throws {EmptySiteError} when no pages are given.
 * @throws {InvalidPageKeyError} when a page key is invalid, duplicated or `index.html` is missing.
 * @throws {AccessCodeRequiredError} when republishing without a code.
 * @throws {IncorrectCodeError} when the code does not open the live site.
 * @throws {NoLivePageError} when the live entry page is missing or unusable.
 * @throws {NothingToRotateError} when rotating a site with no live index.
 */
export async function publishSite(input: PublishInput): Promise<PublishResult> {
  const { pages, store, decoratePage } = input;
  assertPageSet(pages);

  const committed = await sequelize.transaction(async (transaction) => {
    const site = await PagesSite.findByPk(input.site.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
      rejectOnEmpty: true,
    });
    const guarded = createGuardedStore(store, site.slug);
    const prefix = sitePrefix(site.slug);
    const indexKey = prefix + INDEX_PAGE_KEY;
    if (input.rotate && !(await hasLiveIndex(site, transaction))) {
      throw new NothingToRotateError();
    }
    const codeVersion = input.rotate
      ? site.codeVersion + 1
      : Math.max(site.codeVersion, 1);
    const { gate, issuedCode } = await resolveGate(
      input.rotate ? 0 : site.codeVersion,
      input.code,
      guarded,
      indexKey
    );

    // index.html last, after the database writes too: a half-finished publish
    // never exposes a new index that links to pages not yet uploaded, and a
    // failed write never leaves the index under a code nobody was given.
    const ordered = [
      ...pages.filter((p) => p.pageKey !== INDEX_PAGE_KEY),
      ...pages.filter((p) => p.pageKey === INDEX_PAGE_KEY),
    ];
    const storageKey = `pg:${site.slug}:v${codeVersion}`;
    const upload = async (page: RenderedPage) => {
      const html = decoratePage
        ? decoratePage(page.html, { pageKey: page.pageKey, site })
        : page.html;
      const body = renderGatePage({
        title: site.title,
        storageKey,
        salt: gate.salt,
        blob: gate.encryptPage(html),
      });
      await guarded.put(prefix + page.pageKey, body, {
        contentType: "text/html; charset=utf-8",
        cacheControl: "no-cache",
      });
    };
    for (const page of ordered.slice(0, -1)) {
      await upload(page);
    }

    const publishedAt = new Date();
    const existing = await PagesPublication.findAll({
      where: { siteId: site.id },
      transaction,
    });
    for (const page of pages) {
      const values = {
        siteId: site.id,
        pageKey: page.pageKey,
        sourceType:
          page.sourceType === "document"
            ? PagesSourceType.Document
            : PagesSourceType.Collection,
        sourceId: page.sourceId,
        contentHash: crypto
          .createHash("sha256")
          .update(page.html, "utf8")
          .digest("hex"),
        objectKey: prefix + page.pageKey,
        // The title lives here, for Insights, never in the key or the URL.
        title: page.title,
        publishedAt,
        publishedById: input.actorId,
      };
      const row = existing.find((r) => r.pageKey === page.pageKey);
      if (row) {
        await row.update(values, { transaction });
      } else {
        await PagesPublication.create(values, { transaction });
      }
    }
    await PagesPublication.destroy({
      where: {
        siteId: site.id,
        pageKey: { [Op.notIn]: pages.map((p) => p.pageKey) },
      },
      transaction,
    });
    await site.update(
      {
        status: PagesSiteStatus.Published,
        currentVersion: site.currentVersion + 1,
        codeVersion,
        ...(input.rotate
          ? { rotatedAt: publishedAt, rotatedById: input.actorId }
          : {}),
      },
      { transaction }
    );
    await upload(ordered[ordered.length - 1]);

    return {
      guarded,
      prefix,
      indexKey,
      publishedKeys: ordered.map((p) => prefix + p.pageKey),
      version: site.currentVersion,
      codeVersion,
      issuedCode,
    };
  });

  if (input.rotate) {
    // Ids and versions only: never the code, the salt or any request data.
    Logger.info("plugins", "Pages access code rotated", {
      siteId: input.site.id,
      actorId: input.actorId,
      codeVersion: committed.codeVersion,
      currentVersion: committed.version,
    });
  }

  await input.onCommitted?.();
  const { removedKeys, warnings } = await removeStale({
    siteId: input.site.id,
    version: committed.version,
    store: committed.guarded,
    prefix: committed.prefix,
    keep: new Set(committed.publishedKeys),
  });

  return {
    indexKey: committed.indexKey,
    publishedKeys: committed.publishedKeys,
    removedKeys,
    warnings,
    version: committed.version,
    ...(committed.issuedCode === undefined
      ? {}
      : { issuedCode: committed.issuedCode }),
  };
}

/** Refuses an empty set, invalid or duplicate keys, or a missing index. */
function assertPageSet(pages: RenderedPage[]): void {
  if (pages.length === 0) {
    throw new EmptySiteError();
  }
  const seen = new Set<string>();
  for (const page of pages) {
    assertValidPageKey(page.pageKey);
    if (seen.has(page.pageKey)) {
      throw new InvalidPageKeyError("must be unique within a site");
    }
    seen.add(page.pageKey);
  }
  if (!seen.has(INDEX_PAGE_KEY)) {
    throw new InvalidPageKeyError("a site must contain index.html");
  }
}

/** Whether the site has a code in use and a recorded live entry page. */
async function hasLiveIndex(
  site: PagesSite,
  transaction: Transaction
): Promise<boolean> {
  if (site.codeVersion === 0) {
    return false;
  }
  const index = await PagesPublication.count({
    where: { siteId: site.id, pageKey: INDEX_PAGE_KEY },
    transaction,
  });
  return index > 0;
}

/**
 * Issues a new gate (fresh code and salt) when `codeVersion` is 0, which
 * rotation passes too, else verifies the code against the live
 * index and rebuilds the gate with the live salt so readers' keys keep working.
 */
async function resolveGate(
  codeVersion: number,
  code: string | undefined,
  store: ObjectStore,
  indexKey: string
): Promise<{ gate: Gate; issuedCode?: string }> {
  if (codeVersion === 0) {
    const issuedCode = generateAccessCode();
    return { gate: await createGate(issuedCode), issuedCode };
  }
  if (!code) {
    throw new AccessCodeRequiredError();
  }
  const bytes = await store.get(indexKey);
  const liveHtml = bytes ? new TextDecoder().decode(bytes) : "";
  const parsed = parseGatePage(liveHtml);
  if (!parsed || parsed.salt.length !== 16) {
    throw new NoLivePageError();
  }
  if (!(await verifyCode(code, liveHtml))) {
    throw new IncorrectCodeError();
  }
  return { gate: await createGate(code, { salt: parsed.salt }) };
}

/**
 * Deletes every object under the prefix that is not in the published set,
 * holding the site row lock so no later publish can upload meanwhile. Skips
 * entirely when a newer publish has committed, since that publish owns cleanup.
 */
async function removeStale(args: {
  siteId: string;
  version: number;
  store: ObjectStore;
  prefix: string;
  keep: Set<string>;
}): Promise<{ removedKeys: string[]; warnings: string[] }> {
  const { store, prefix, keep } = args;
  const removedKeys: string[] = [];
  let failed = 0;
  try {
    await sequelize.transaction(async (transaction) => {
      const site = await PagesSite.findByPk(args.siteId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
        rejectOnEmpty: true,
      });
      if (site.currentVersion !== args.version) {
        return;
      }
      const stale = (await store.list(prefix)).filter((key) => !keep.has(key));
      for (const key of stale) {
        try {
          await store.delete(key);
          removedKeys.push(key);
        } catch {
          failed++;
        }
      }
    });
  } catch {
    return {
      removedKeys,
      warnings: ["Old objects could not be cleaned up; they remain in storage"],
    };
  }
  const warnings =
    failed > 0
      ? [`${failed} old object(s) could not be removed; they remain in storage`]
      : [];
  return { removedKeys, warnings };
}
