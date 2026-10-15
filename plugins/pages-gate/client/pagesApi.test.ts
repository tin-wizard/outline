import { client } from "~/utils/ApiClient";
import {
  NO_RETRY,
  deleteSite,
  loadInsights,
  publishSite,
  rotateSite,
  unpublishSite,
} from "./pagesApi";

vi.mock("~/utils/ApiClient", () => ({
  client: { post: vi.fn(async () => ({ data: {} })) },
}));

const post = vi.mocked(client.post);

afterEach(() => {
  post.mockClear();
});

describe("pagesApi", () => {
  it("never retries a call that writes a whole site", async () => {
    await publishSite({ id: "s", sources: [], accessCode: "x" });
    await rotateSite({ id: "s", sources: [] });
    await unpublishSite("s");
    await deleteSite("s");

    expect(NO_RETRY).toEqual({ retry: false });
    expect(post.mock.calls.map(([path, , options]) => [path, options])).toEqual(
      [
        ["/pages.publish", { retry: false }],
        ["/pages.rotate", { retry: false }],
        ["/pages.unpublish", { retry: false }],
        ["/pages.delete", { retry: false }],
      ]
    );
  });

  it("keeps the default retry for reads", async () => {
    await loadInsights({ id: "s", period: "day", days: 7 });

    expect(post.mock.calls[0][2]).toBeUndefined();
  });
});
