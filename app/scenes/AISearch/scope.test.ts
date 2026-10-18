import {
  MAX_SCOPE_COLLECTIONS,
  MAX_SCOPE_DOCUMENTS,
  buildAskParams,
  describeScope,
  isDay,
  presetFrom,
  rangeError,
  resolveScope,
  scopeFromParams,
  withCollections,
  withDates,
  withDocuments,
} from "./scope";

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const t = (key: string, options?: Record<string, unknown>) =>
  key.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) =>
    String(options?.[name])
  );

describe("presetFrom", () => {
  it("subtracts calendar days in UTC", () => {
    const now = new Date("2026-10-18T12:00:00Z");
    expect(presetFrom("week", now)).toBe("2026-10-11");
    expect(presetFrom("month", now)).toBe("2026-09-18");
    expect(presetFrom("year", now)).toBe("2025-10-18");
  });

  it("is not moved by daylight saving or the local zone", () => {
    // 00:30 UTC on the day the clocks change in many zones.
    expect(presetFrom("week", new Date("2026-03-29T00:30:00Z"))).toBe(
      "2026-03-22"
    );
    expect(presetFrom("week", new Date("2026-11-01T23:59:59Z"))).toBe(
      "2026-10-25"
    );
    // Late on the 31st UTC is already the 1st in Auckland.
    expect(presetFrom("month", new Date("2026-12-31T23:59:59Z"))).toBe(
      "2026-12-01"
    );
  });

  it("crosses year and leap-day boundaries", () => {
    expect(presetFrom("week", new Date("2026-01-03T00:00:00Z"))).toBe(
      "2025-12-27"
    );
    expect(presetFrom("year", new Date("2024-02-29T00:00:00Z"))).toBe(
      "2023-03-01"
    );
  });
});

describe("resolveScope", () => {
  it("turns a preset into a concrete start date", () => {
    const resolved = resolveScope(
      { datePreset: "month" },
      new Date("2026-10-18T00:00:00Z")
    );
    expect(resolved.dateFrom).toBe("2026-09-18");
    expect(resolved.dateTo).toBeUndefined();
  });

  it("keeps a custom range", () => {
    const scope = {
      datePreset: "custom" as const,
      dateFrom: "2026-01-01",
      dateTo: "2026-02-01",
    };
    expect(resolveScope(scope)).toBe(scope);
  });
});

describe("dates", () => {
  it("accepts only real calendar days", () => {
    expect(isDay("2026-02-28")).toBe(true);
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("2026-2-3")).toBe(false);
    expect(isDay("2026-10-18T00:00:00Z")).toBe(false);
    expect(isDay(undefined)).toBe(false);
  });

  it("reports order and invalid dates", () => {
    expect(rangeError("2026-01-01", "2026-01-01")).toBeUndefined();
    expect(rangeError("2026-01-02", "2026-01-01")).toBe("order");
    expect(rangeError("2026-13-01", undefined)).toBe("invalid");
    expect(rangeError(undefined, "2026-01-05")).toBeUndefined();
  });
});

describe("buildAskParams", () => {
  it("sends nothing for an empty scope", () => {
    expect(buildAskParams({})).toEqual({});
    expect(buildAskParams({ collectionIds: [], documents: [] })).toEqual({});
  });

  it("sends collections, documents, dates and mode", () => {
    expect(
      buildAskParams({
        collectionIds: [ID(1)],
        documents: [{ id: ID(2), title: "Not sent" }],
        dateFrom: "2026-09-01",
        dateTo: "2026-10-01",
        mode: "compare",
      })
    ).toEqual({
      collectionIds: [ID(1)],
      documentIds: [ID(2)],
      dateFrom: "2026-09-01",
      dateTo: "2026-10-01",
      mode: "compare",
    });
  });

  it("never sends the answer mode or malformed dates", () => {
    const params = buildAskParams({
      mode: "answer",
      dateFrom: "yesterday",
      dateTo: "2026-02-30",
    });
    expect(params).toEqual({});
  });

  it("applies the server caps", () => {
    const params = buildAskParams({
      collectionIds: Array.from({ length: 12 }, (_, i) => ID(i)),
      documents: Array.from({ length: 25 }, (_, i) => ({
        id: ID(i),
        title: "x",
      })),
    });
    expect(params.collectionIds).toHaveLength(MAX_SCOPE_COLLECTIONS);
    expect(params.documentIds).toHaveLength(MAX_SCOPE_DOCUMENTS);
  });
});

describe("mutual exclusion", () => {
  it("choosing documents clears collections, and the reverse", () => {
    const withColl = withCollections({}, [ID(1), ID(2)]);
    const docs = withDocuments(withColl, [{ id: ID(3), title: "A" }]);
    expect(docs.collectionIds).toEqual([]);
    expect(docs.documents).toHaveLength(1);
    const back = withCollections(docs, [ID(1)]);
    expect(back.documents).toEqual([]);
    expect(back.collectionIds).toEqual([ID(1)]);
  });

  it("clearing one choice leaves the other alone", () => {
    const docs = withDocuments({}, [{ id: ID(3), title: "A" }]);
    expect(withCollections(docs, []).documents).toHaveLength(1);
    const colls = withCollections({}, [ID(1)]);
    expect(withDocuments(colls, []).collectionIds).toEqual([ID(1)]);
  });

  it("caps the selection", () => {
    const ids = Array.from({ length: 15 }, (_, i) => ID(i));
    expect(withCollections({}, ids).collectionIds).toHaveLength(10);
    const docs = ids.concat(ids).map((id) => ({ id, title: "x" }));
    expect(withDocuments({}, docs).documents).toHaveLength(20);
  });

  it("keeps other parts when the dates change", () => {
    const scope = withDates({ collectionIds: [ID(1)] }, "week");
    expect(scope).toMatchObject({ collectionIds: [ID(1)], datePreset: "week" });
    const cleared = withDates(scope, undefined);
    expect(cleared.datePreset).toBeUndefined();
    const custom = withDates(scope, "custom", { dateFrom: "2026-01-01" });
    expect(custom.dateFrom).toBe("2026-01-01");
    expect(withDates(custom, "month").dateFrom).toBeUndefined();
  });
});

describe("scopeFromParams", () => {
  it("prefills a collection", () => {
    expect(scopeFromParams(ID(1), null)).toEqual({ collectionIds: [ID(1)] });
  });

  it("prefers the document when both are given", () => {
    expect(scopeFromParams(ID(1), ID(2))).toEqual({
      documents: [{ id: ID(2), title: "" }],
    });
  });

  it("drops anything that is not a UUID", () => {
    expect(scopeFromParams("../x", "nope")).toEqual({});
  });
});

describe("describeScope", () => {
  const names = {
    collection: (id: string) => (id === ID(1) ? "Engineering" : "Partners"),
  };
  const base = { names, t, language: "en_US" };

  it("is empty for an unscoped question", () => {
    expect(describeScope({ ...base, scope: {} })).toBeUndefined();
  });

  it("lists collections with the date", () => {
    expect(
      describeScope({
        ...base,
        scope: { collectionIds: [ID(1), ID(2)], datePreset: "week" },
      })
    ).toEqual({
      kind: "collections",
      text: "Engineering, Partners · Past week",
    });
  });

  it("says Any time without dates", () => {
    expect(
      describeScope({ ...base, scope: { collectionIds: [ID(1)] } })?.text
    ).toBe("Engineering · Any time");
  });

  it("shows documents instead of collections", () => {
    expect(
      describeScope({
        ...base,
        scope: { documents: [{ id: ID(3), title: "Travel Policy" }] },
      })
    ).toEqual({ kind: "documents", text: "Travel Policy · Any time" });
  });

  it("shows a date range on its own", () => {
    const line = describeScope({
      ...base,
      scope: { dateFrom: "2026-09-01" },
    });
    expect(line?.kind).toBe("all");
    expect(line?.text).toBe("All collections · Since Sep 1, 2026");
  });

  it("labels compare turns with the document count", () => {
    expect(
      describeScope({
        ...base,
        scope: { mode: "compare" },
        sourceCount: 2,
      })
    ).toEqual({ kind: "compare", text: "Comparing 2 documents" });
    expect(describeScope({ ...base, scope: { mode: "compare" } })?.text).toBe(
      "Comparing documents"
    );
  });

  it("describes hidden stored entries without ids", () => {
    const line = describeScope({
      ...base,
      scope: {},
      stored: {
        collections: [{ id: ID(1), name: "Engineering" }, { id: ID(9) }],
        documents: [],
      },
    });
    expect(line?.text).toBe(
      "Engineering, a collection that is no longer available · Any time"
    );
    expect(line?.text).not.toContain(ID(9));
    const docs = describeScope({
      ...base,
      scope: {},
      stored: { collections: [], documents: [{ id: ID(5) }] },
    });
    expect(docs?.text).toBe(
      "a document that is no longer available · Any time"
    );
  });

  it("uses the stored dates of a resumed turn", () => {
    const line = describeScope({
      ...base,
      scope: {},
      stored: {
        collections: [{ id: ID(1), name: "Engineering" }],
        documents: [],
        dateFrom: "2026-09-01",
        dateTo: "2026-10-01",
      },
    });
    expect(line?.text).toBe("Engineering · Sep 1, 2026 to Oct 1, 2026");
  });

  it("keeps compare for resumed turns", () => {
    const line = describeScope({
      ...base,
      scope: { mode: "compare" },
      sourceCount: 3,
      stored: { collections: [], documents: [{ id: ID(5), title: "A" }] },
    });
    expect(line?.kind).toBe("compare");
    expect(line?.text).toBe("Comparing 3 documents · A");
  });
});
