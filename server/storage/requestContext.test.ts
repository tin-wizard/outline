import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { User } from "@server/models";
import { buildUser } from "@server/test/factories";
import { sequelize } from "./database";
import { releaseRequestTransaction, requestContext } from "./requestContext";

const newStore = () => ({ req: new IncomingMessage(new Socket()) });

describe("releaseRequestTransaction", () => {
  it("is a no-op outside a request context", async () => {
    await expect(releaseRequestTransaction()).resolves.toEqual(false);
  });

  it("is a no-op when the request has no transaction", async () => {
    await requestContext.run(newStore(), async () => {
      await expect(releaseRequestTransaction()).resolves.toEqual(false);
    });
  });

  it("commits and detaches the transaction, later reads use the pool", async () => {
    const user = await buildUser();
    const store = newStore();

    await requestContext.run(store, async () => {
      const t = await sequelize.transaction();
      const commit = vi.spyOn(t, "commit");
      Object.assign(store, { transaction: t });

      // Routed through the pinned transaction before the release.
      const before = vi.fn();
      sequelize.addHook("beforeFind", "releaseTest", (options) =>
        before(options.transaction)
      );
      try {
        await User.findByPk(user.id);
        expect(before).toHaveBeenLastCalledWith(t);

        await expect(releaseRequestTransaction()).resolves.toEqual(true);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(requestContext.getStore()?.transaction).toBeUndefined();

        // Would throw "commit has been called" if still routed through t.
        const found = await User.findByPk(user.id);
        expect(found?.id).toEqual(user.id);
        expect(before).toHaveBeenLastCalledWith(undefined);
      } finally {
        sequelize.removeHook("beforeFind", "releaseTest");
      }
    });
  });

  it("propagates a commit failure after detaching the transaction", async () => {
    const store = newStore();

    await requestContext.run(store, async () => {
      const t = await sequelize.transaction();
      Object.assign(store, { transaction: t });
      vi.spyOn(t, "commit").mockRejectedValueOnce(new Error("commit failed"));

      await expect(releaseRequestTransaction()).rejects.toThrow(
        "commit failed"
      );
      expect(requestContext.getStore()?.transaction).toBeUndefined();
      await t.rollback();
    });
  });
});
