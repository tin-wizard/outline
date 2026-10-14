import { PagesInsight } from "@server/models";
import { PagesInsightPeriod } from "./PagesInsight";
import { buildPagesSite } from "plugins/pages-gate/server/test/factories";

describe("PagesInsight", () => {
  it("applies defaults and is unique on (siteId, pageKey, date, period)", async () => {
    const site = await buildPagesSite();
    const attrs = {
      siteId: site.id,
      pageKey: "",
      // Today, so retention cleanup elsewhere never deletes it mid-test.
      date: new Date().toISOString().slice(0, 10),
      period: PagesInsightPeriod.Day,
    };
    const insight = await PagesInsight.create(attrs);
    expect(insight.viewCount).toBe(0);
    expect(insight.visitorCount).toBe(0);
    expect(insight.totalActiveSeconds).toBe(0);
    expect(insight.timeHistogram).toEqual({});
    await expect(PagesInsight.create(attrs)).rejects.toThrow();
    await expect(
      PagesInsight.create({ ...attrs, period: PagesInsightPeriod.Week })
    ).resolves.toBeDefined();
  });
});
