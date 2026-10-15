import { buildAdmin } from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import env from "../env";

// No PAGES_* variables are set in the test environment, so the plugin's index
// registers nothing and the routes must not exist.
const server = getTestServer();

describe("pages routes when the plugin is disabled", () => {
  it("is disabled in the test environment", () => {
    expect(env.PAGES_ENABLED).toBe(false);
  });

  it.each([
    "pages.list",
    "pages.info",
    "pages.create",
    "pages.update",
    "pages.publish",
    "pages.rotate",
    "pages.unpublish",
    "pages.delete",
    "pages.insights",
    "pages.ingest",
  ])("%s is not found", async (route) => {
    const admin = await buildAdmin();
    const res = await server.post(`/api/${route}`, admin, { body: {} });
    expect(res.status).toEqual(404);
  });
});
