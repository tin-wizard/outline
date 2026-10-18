import type { MockInstance } from "vitest";
import stores from "~/stores";
import { client } from "~/utils/ApiClient";
import { NotFoundError } from "~/utils/errors";

const conv = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  title: `Chat ${id}`,
  pinnedAt: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  ...patch,
});

// Only aiConversations calls are answered; the auth store's own startup
// request (made on import) is left pending.
const reply = vi.fn();
let post: MockInstance;

describe("AIConversationsStore", () => {
  beforeEach(() => {
    stores.aiConversations.clear();
    reply.mockReset();
    post = vi
      .spyOn(client, "post")
      .mockImplementation((path: string, ...args: unknown[]) =>
        path.startsWith("/aiConversations")
          ? reply(path, ...args)
          : new Promise(() => undefined)
      );
  });

  afterEach(() => {
    post.mockRestore();
  });

  it("is registered on the root store with the aiConversations endpoint", () => {
    expect(stores.aiConversations.apiEndpoint).toBe("aiConversations");
  });

  it("fetchPage posts pagination and filters and adds the models", async () => {
    reply.mockResolvedValue({
      data: [conv("a"), conv("b")],
      pagination: { offset: 20, limit: 20 },
    });
    const page = await stores.aiConversations.fetchPage({
      offset: 20,
      limit: 20,
      query: "leave",
      pinned: false,
    });
    expect(reply).toHaveBeenCalledWith("/aiConversations.list", {
      offset: 20,
      limit: 20,
      query: "leave",
      pinned: false,
    });
    expect(page.map((c) => c.id)).toEqual(["a", "b"]);
    expect(stores.aiConversations.get("a")?.title).toBe("Chat a");
  });

  it("orders pinned first, then newest first", () => {
    const s = stores.aiConversations;
    s.add(conv("old", { updatedAt: "2026-10-01T00:00:00.000Z" }));
    s.add(conv("new", { updatedAt: "2026-10-05T00:00:00.000Z" }));
    s.add(
      conv("pinned", {
        updatedAt: "2026-09-01T00:00:00.000Z",
        pinnedAt: "2026-09-02T00:00:00.000Z",
      })
    );
    expect(s.orderedData.map((c) => c.id)).toEqual(["pinned", "new", "old"]);
  });

  it("fetch loads turns from info and does not reorder via rename or pin", async () => {
    reply.mockResolvedValue({
      data: { ...conv("a"), turns: [{ id: "t", question: "Q" }] },
    });
    const c = await stores.aiConversations.fetch("a");
    expect(reply).toHaveBeenCalledWith("/aiConversations.info", { id: "a" });
    expect(c.turns?.[0].question).toBe("Q");
  });

  it("fetch of a missing conversation rejects and drops it from the store", async () => {
    stores.aiConversations.add(conv("gone"));
    reply.mockRejectedValue(new NotFoundError());
    await expect(
      stores.aiConversations.fetch("gone", { force: true })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(stores.aiConversations.get("gone")).toBeUndefined();
  });

  it("rename posts the title and updates the model, keeping its turns", async () => {
    const c = stores.aiConversations.add({ ...conv("a"), turns: [] });
    reply.mockResolvedValue({ data: conv("a", { title: "Renamed" }) });
    await stores.aiConversations.rename(c, "Renamed");
    expect(reply).toHaveBeenCalledWith("/aiConversations.update", {
      id: "a",
      title: "Renamed",
    });
    expect(stores.aiConversations.get("a")?.title).toBe("Renamed");
    expect(stores.aiConversations.get("a")?.turns).toEqual([]);
  });

  it("setPinned pins and unpins", async () => {
    const c = stores.aiConversations.add(conv("a"));
    reply.mockResolvedValue({
      data: conv("a", { pinnedAt: "2026-10-18T00:00:00.000Z" }),
    });
    await stores.aiConversations.setPinned(c, true);
    expect(reply).toHaveBeenCalledWith("/aiConversations.update", {
      id: "a",
      pinned: true,
    });
    expect(c.isPinned).toBe(true);
    reply.mockResolvedValue({ data: conv("a", { pinnedAt: null }) });
    await stores.aiConversations.setPinned(c, false);
    expect(c.isPinned).toBe(false);
  });

  it("a failed update leaves the model unchanged and clears saving", async () => {
    const c = stores.aiConversations.add(conv("a"));
    reply.mockRejectedValue(new Error("boom"));
    await expect(stores.aiConversations.rename(c, "x")).rejects.toThrow();
    expect(c.title).toBe("Chat a");
    expect(stores.aiConversations.isSaving).toBe(false);
  });

  it("delete posts and removes the model", async () => {
    const c = stores.aiConversations.add(conv("a"));
    reply.mockResolvedValue({ success: true });
    await stores.aiConversations.delete(c);
    expect(reply).toHaveBeenCalledWith("/aiConversations.delete", { id: "a" });
    expect(stores.aiConversations.get("a")).toBeUndefined();
  });
});
