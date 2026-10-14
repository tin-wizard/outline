import { PagesViewEvent } from "@server/models";
import { buildPagesSite } from "plugins/pages-gate/server/test/factories";

describe("PagesViewEvent", () => {
  it("is unique on (siteId, sessionId, pageKey, startedAt)", async () => {
    const site = await buildPagesSite();
    const startedAt = new Date();
    const attrs = {
      siteId: site.id,
      pageKey: "index.html",
      sessionId: "session-1",
      startedAt,
      lastSeenAt: startedAt,
    };
    const event = await PagesViewEvent.create(attrs);
    expect(event.activeSeconds).toBe(0);
    await expect(PagesViewEvent.create(attrs)).rejects.toThrow();
  });
});
