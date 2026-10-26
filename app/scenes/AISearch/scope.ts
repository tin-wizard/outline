import { isUUID } from "validator";
import type { StoredScope } from "~/models/AIConversation";
import { formatWhen } from "./dates";
import type { DatePreset, Scope, ScopeDocument } from "./model";

/** The most collections the server accepts in one question. */
export const MAX_SCOPE_COLLECTIONS = 10;
/** The most specific documents the server accepts in one question. */
export const MAX_SCOPE_DOCUMENTS = 20;

const PRESET_DAYS: Record<Exclude<DatePreset, "custom">, number> = {
  week: 7,
  month: 30,
  year: 365,
};

/** The date presets in menu order. */
export const DATE_PRESETS: Exclude<DatePreset, "custom">[] = [
  "week",
  "month",
  "year",
];

/** The body fields of `ai.ask` that carry the scope. */
export interface AskScopeParams {
  collectionIds?: string[];
  documentIds?: string[];
  dateFrom?: string;
  dateTo?: string;
  mode?: "compare";
}

/**
 * Formats a date as YYYY-MM-DD in UTC.
 *
 * @param date the instant.
 * @returns the UTC calendar day.
 */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The first day of a preset window: today (UTC) minus N days. Calendar
 * arithmetic is done in UTC, so daylight saving never moves the day.
 *
 * @param preset the window.
 * @param now the current time, injectable for tests.
 * @returns the YYYY-MM-DD UTC day.
 */
export function presetFrom(
  preset: Exclude<DatePreset, "custom">,
  now: Date = new Date()
): string {
  return utcDay(
    new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - PRESET_DAYS[preset]
      )
    )
  );
}

/**
 * Fixes a preset to concrete dates at ask time, so a chat left open overnight
 * still means "past week" relative to the moment the question is sent.
 *
 * @param scope the scope as chosen in the composer.
 * @param now the current time, injectable for tests.
 * @returns the scope with `dateFrom` resolved for presets.
 */
export function resolveScope(scope: Scope, now: Date = new Date()): Scope {
  if (!scope.datePreset || scope.datePreset === "custom") {
    return scope;
  }
  return {
    ...scope,
    dateFrom: presetFrom(scope.datePreset, now),
    dateTo: undefined,
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a string is a real YYYY-MM-DD calendar day.
 *
 * @param value the string.
 * @returns true for existing days such as 2026-02-28, false for 2026-02-30.
 */
export function isDay(value: string | undefined): value is string {
  if (!value || !DAY.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && utcDay(date) === value;
}

/**
 * Checks a custom range the way the server does.
 *
 * @param from the first day, if set.
 * @param to the last day, if set.
 * @returns "invalid" for a date that doesn't exist, "order" when from is after
 * to, otherwise undefined.
 */
export function rangeError(
  from: string | undefined,
  to: string | undefined
): "invalid" | "order" | undefined {
  if ((from && !isDay(from)) || (to && !isDay(to))) {
    return "invalid";
  }
  return from && to && from > to ? "order" : undefined;
}

/**
 * Builds the scope fields of an `ai.ask` request. Empty parts are omitted and
 * the caps the server enforces are applied.
 *
 * @param scope the scope, with presets already resolved by `resolveScope`.
 * @returns the request fields.
 */
export function buildAskParams(scope: Scope): AskScopeParams {
  const collectionIds = (scope.collectionIds ?? []).slice(
    0,
    MAX_SCOPE_COLLECTIONS
  );
  const documentIds = (scope.documents ?? [])
    .map((d) => d.id)
    .slice(0, MAX_SCOPE_DOCUMENTS);
  return {
    ...(collectionIds.length ? { collectionIds } : {}),
    ...(documentIds.length ? { documentIds } : {}),
    ...(isDay(scope.dateFrom) ? { dateFrom: scope.dateFrom } : {}),
    ...(isDay(scope.dateTo) ? { dateTo: scope.dateTo } : {}),
    ...(scope.mode === "compare" ? { mode: "compare" as const } : {}),
  };
}

/**
 * Chooses the collections to search. Specific documents are cleared: the two
 * ways of scoping replace each other.
 *
 * @param scope the current scope.
 * @param ids the chosen collection ids (extra ones beyond the cap are ignored).
 * @returns the new scope.
 */
export function withCollections(scope: Scope, ids: string[]): Scope {
  return {
    ...scope,
    collectionIds: ids.slice(0, MAX_SCOPE_COLLECTIONS),
    documents: ids.length ? [] : scope.documents,
  };
}

/**
 * Chooses the specific documents to search. Collections are cleared.
 *
 * @param scope the current scope.
 * @param documents the chosen documents (extra ones beyond the cap are ignored).
 * @returns the new scope.
 */
export function withDocuments(scope: Scope, documents: ScopeDocument[]): Scope {
  return {
    ...scope,
    documents: documents.slice(0, MAX_SCOPE_DOCUMENTS),
    collectionIds: documents.length ? [] : scope.collectionIds,
  };
}

/**
 * Sets the date window.
 *
 * @param scope the current scope.
 * @param next the preset, or undefined for any time; `custom` keeps the range.
 * @param range the custom range.
 * @returns the new scope.
 */
export function withDates(
  scope: Scope,
  next: DatePreset | undefined,
  range: { dateFrom?: string; dateTo?: string } = {}
): Scope {
  return {
    ...scope,
    datePreset: next,
    dateFrom: next === "custom" ? range.dateFrom : undefined,
    dateTo: next === "custom" ? range.dateTo : undefined,
  };
}

/** One piece of what a question was limited to, ready to render. */
export interface ScopeLine {
  /** Picks the icon. */
  kind: "collections" | "documents" | "compare" | "all";
  text: string;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Resolves ids to names while they are still visible to the reader. */
export interface ScopeNames {
  collection: (id: string) => string | undefined;
}

/**
 * Text for a date window: a preset name, a range, or "Any time".
 *
 * @param scope the window.
 * @param t the translate function.
 * @param language the UI language.
 * @returns the label.
 */
export function dateText(
  scope: {
    datePreset?: DatePreset;
    dateFrom?: string;
    dateTo?: string;
  },
  t: Translate,
  language: string
): string {
  switch (scope.datePreset) {
    case "week":
      return t("Past week");
    case "month":
      return t("Past month");
    case "year":
      return t("Past year");
    default:
      break;
  }
  const from = formatWhen(scope.dateFrom, language, { utc: true });
  const to = formatWhen(scope.dateTo, language, { utc: true });
  if (from && to) {
    return t("{{ from }} to {{ to }}", { from, to });
  }
  if (from) {
    return t("Since {{ date }}", { date: from });
  }
  if (to) {
    return t("Until {{ date }}", { date: to });
  }
  return t("Any time");
}

/**
 * Describes what a question was limited to for the line under it. Names come
 * from the live scope (resolved through `names`) or from the scope the server
 * stored; an entry the server could no longer name is described as no longer
 * available rather than by id.
 *
 * @param input.scope the scope sent with the question (live turns).
 * @param input.stored the stored scope of a resumed turn.
 * @param input.sourceCount documents the answer was built from (compare).
 * @param input.names resolves collection names.
 * @param input.t the translate function.
 * @param input.language the UI language.
 * @returns the line, or undefined when the question had no scope at all.
 */
export function describeScope(input: {
  scope: Scope;
  stored?: StoredScope;
  sourceCount?: number;
  names: ScopeNames;
  t: Translate;
  language: string;
}): ScopeLine | undefined {
  const { scope, stored, names, t, language } = input;
  const collections = stored
    ? stored.collections.map((c) => c.name)
    : (scope.collectionIds ?? []).map((id) => names.collection(id));
  const documents = stored
    ? stored.documents.map((d) => d.title)
    : (scope.documents ?? []).map((d) => d.title || undefined);
  const dates = stored
    ? { dateFrom: stored.dateFrom, dateTo: stored.dateTo }
    : {
        datePreset: scope.datePreset,
        dateFrom: scope.dateFrom,
        dateTo: scope.dateTo,
      };
  const dated = !!(dates.dateFrom || dates.dateTo);
  const compare = scope.mode === "compare";
  if (!collections.length && !documents.length && !dated && !compare) {
    return undefined;
  }

  const parts: string[] = [];
  if (compare) {
    parts.push(
      input.sourceCount && input.sourceCount >= 2
        ? t("Comparing {{ count }} documents", { count: input.sourceCount })
        : t("Comparing documents")
    );
  }
  if (documents.length) {
    parts.push(
      documents
        .map((title) => title ?? t("a document that is no longer available"))
        .join(", ")
    );
  } else if (collections.length) {
    parts.push(
      collections
        .map((name) => name ?? t("a collection that is no longer available"))
        .join(", ")
    );
  }
  if (!compare || dated) {
    parts.push(dateText(dates, t, language));
  }
  return {
    kind: compare
      ? "compare"
      : documents.length
        ? "documents"
        : collections.length
          ? "collections"
          : "all",
    text:
      !compare && !documents.length && !collections.length
        ? [t("All collections"), ...parts].join(" · ")
        : parts.join(" · "),
  };
}

/**
 * Keeps only well-formed UUIDs from a query string value.
 *
 * @param value the raw value.
 * @returns the id, or undefined.
 */
export function validId(value: string | null): string | undefined {
  return value && isUUID(value) ? value : undefined;
}

/**
 * The initial scope from the `collectionId` and `documentId` query
 * parameters set by Ask AI buttons. A document is narrower than its
 * collection, so when both are given the document wins.
 *
 * @param collectionId the raw `collectionId` value.
 * @param documentId the raw `documentId` value.
 * @returns the scope. Document titles are filled in at render time.
 */
export function scopeFromParams(
  collectionId: string | null,
  documentId: string | null
): Scope {
  const doc = validId(documentId);
  if (doc) {
    return { documents: [{ id: doc, title: "" }] };
  }
  const collection = validId(collectionId);
  return collection ? { collectionIds: [collection] } : {};
}

/**
 * The composer scope to continue a resumed chat with: what its last question
 * was limited to, minus entries the reader can no longer see. Compare is not
 * carried over.
 *
 * @param stored the stored scope of the last turn.
 * @returns the scope.
 */
export function scopeFromStored(stored: StoredScope): Scope {
  const documents = stored.documents.flatMap((d) =>
    d.title ? [{ id: d.id, title: d.title }] : []
  );
  const collectionIds = stored.collections.flatMap((c) =>
    c.name ? [c.id] : []
  );
  return {
    ...(documents.length
      ? { documents: documents.slice(0, MAX_SCOPE_DOCUMENTS) }
      : collectionIds.length
        ? { collectionIds: collectionIds.slice(0, MAX_SCOPE_COLLECTIONS) }
        : {}),
    ...(stored.dateFrom || stored.dateTo
      ? {
          datePreset: "custom" as const,
          dateFrom: stored.dateFrom,
          dateTo: stored.dateTo,
        }
      : {}),
  };
}
