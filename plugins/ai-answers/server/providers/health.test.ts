import { randomUUID } from "node:crypto";
import Logger from "@server/logging/Logger";
import Redis from "@server/storage/redis";
import { alertProviderDown, COOLDOWN_MS, defaultHealth } from "./health";

describe("alertProviderDown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("alerts once per hour per provider and kind", async () => {
    const error = vi.spyOn(Logger, "error").mockImplementation(() => {});
    const provider = `p-${randomUUID()}`;

    await alertProviderDown(provider, "billing");
    await alertProviderDown(provider, "billing");
    await alertProviderDown(provider, "auth");

    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      "AI answers provider unavailable",
      expect.any(Error),
      { provider, kind: "billing" }
    );
    expect(
      await Redis.defaultClient.ttl(
        `ai-answers:provider-alert:${provider}:billing`
      )
    ).toBeGreaterThan(3500);
  });

  it("never throws when Redis fails", async () => {
    vi.spyOn(Redis.defaultClient, "set").mockRejectedValue(new Error("down"));
    await expect(
      alertProviderDown(`p-${randomUUID()}`, "auth")
    ).resolves.toBeUndefined();
  });
});

describe("defaultHealth", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes the breaker once the cooldown has passed", () => {
    vi.useFakeTimers();
    const id = `p-${randomUUID()}`;
    defaultHealth.trip(id, "rate_limit");
    expect(defaultHealth.isOpen(id)).toEqual(true);
    vi.advanceTimersByTime(COOLDOWN_MS.rate_limit - 1);
    expect(defaultHealth.isOpen(id)).toEqual(true);
    vi.advanceTimersByTime(1);
    expect(defaultHealth.isOpen(id)).toEqual(false);
  });
});
