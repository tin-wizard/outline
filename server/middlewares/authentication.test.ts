import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { DefaultState } from "koa";
import type { Transaction } from "sequelize";
import type { MockInstance } from "vitest";
import {
  releaseRequestTransaction,
  requestContext,
} from "@server/storage/requestContext";
import { errToString } from "@shared/utils/error";
import { randomString } from "@shared/random";
import { Scope } from "@shared/types";
import {
  buildUser,
  buildTeam,
  buildAdmin,
  buildApiKey,
  buildOAuthAuthentication,
} from "@server/test/factories";
import { getBaseDomain, parseDomain } from "@shared/utils/domains";
import env from "@server/env";
import { Team } from "@server/models";
import { AuthenticationType } from "@server/types";
import { resetVaultModeCache } from "@server/utils/vault";
import auth from "./authentication";

describe("Authentication middleware", () => {
  describe("with session JWT", () => {
    it("should authenticate with correct session token", async () => {
      const state = {} as DefaultState;
      const user = await buildUser();
      const authMiddleware = auth();
      await authMiddleware(
        {
          // @ts-expect-error mock request
          request: {
            get: vi.fn(() => `Bearer ${user.getSessionToken()}`),
          },
          state,
          cache: {},
        },
        vi.fn()
      );
      expect(state.auth.user.id).toEqual(user.id);
    });

    it("should return error with invalid session token", async () => {
      const state = {} as DefaultState;
      const user = await buildUser();
      const authMiddleware = auth();

      try {
        await authMiddleware(
          {
            // @ts-expect-error mock request
            request: {
              get: vi.fn(() => `Bearer ${user.getSessionToken()}error`),
            },
            state,
            cache: {},
          },
          vi.fn()
        );
      } catch (e) {
        expect(errToString(e)).toBe("Invalid token");
      }
    });

    it("should return error if AuthenticationType mismatches", async () => {
      const state = {} as DefaultState;
      const user = await buildUser();
      const authMiddleware = auth({
        type: AuthenticationType.API,
      });

      try {
        await authMiddleware(
          {
            // @ts-expect-error mock request
            request: {
              get: vi.fn(() => `Bearer ${user.getSessionToken()}`),
            },
            state,
            cache: {},
          },
          vi.fn()
        );
      } catch (e) {
        expect(errToString(e)).toBe("Invalid authentication type");
      }
    });
  });

  describe("with API key", () => {
    it("should authenticate user with valid API key", async () => {
      const state = {} as DefaultState;
      const user = await buildUser();
      const authMiddleware = auth();
      const key = await buildApiKey({ userId: user.id });
      await authMiddleware(
        {
          // @ts-expect-error mock request
          request: {
            get: vi.fn(() => `Bearer ${key.value}`),
          },
          state,
          cache: {},
        },
        vi.fn()
      );
      expect(state.auth.user.id).toEqual(user.id);
    });
    it("should authenticate with global read scope on read endpoints", async () => {
      const state = {} as DefaultState;
      const user = await buildUser();
      const authMiddleware = auth();
      const key = await buildApiKey({
        userId: user.id,
        scope: [Scope.Read],
      });

      await authMiddleware(
        {
          originalUrl: "/api/auth.info",
          // @ts-expect-error mock request
          request: {
            url: "/auth.info",
            get: vi.fn(() => `Bearer ${key.value}`),
          },
          state,
          cache: {},
        },
        vi.fn()
      );
      expect(state.auth.user.id).toEqual(user.id);
    });

    it("should return 403 authorization error when scope does not match", async () => {
      const state = {} as DefaultState;
      const user = await buildUser();
      const authMiddleware = auth();
      const key = await buildApiKey({
        userId: user.id,
        scope: [Scope.Read],
      });

      try {
        await authMiddleware(
          {
            originalUrl: "/api/documents.create",
            // @ts-expect-error mock request
            request: {
              url: "/documents.create",
              get: vi.fn(() => `Bearer ${key.value}`),
            },
            state,
            cache: {},
          },
          vi.fn()
        );
        throw new Error("Expected error to be thrown");
      } catch (e) {
        expect(e).toHaveProperty("status", 403);
        expect(e).toHaveProperty("id", "authorization_error");
        expect(errToString(e)).toContain(
          "does not have access to this resource"
        );
      }
    });

    it("should return error with invalid API key", async () => {
      const state = {} as DefaultState;
      const authMiddleware = auth();

      try {
        await authMiddleware(
          {
            // @ts-expect-error mock request
            request: {
              get: vi.fn(() => `Bearer ${randomString(38)}`),
            },
            state,
            cache: {},
          },
          vi.fn()
        );
      } catch (e) {
        expect(errToString(e)).toBe("Invalid API key");
      }
    });
  });

  describe("with OAuth access token", () => {
    it("should authenticate user with valid OAuth access token", async () => {
      const state = {} as DefaultState;
      const user = await buildUser();
      const authMiddleware = auth();
      const authentication = await buildOAuthAuthentication({
        user,
        scope: [Scope.Read],
      });

      await authMiddleware(
        {
          originalUrl: "/api/users.info",
          // @ts-expect-error mock request
          request: {
            url: "/users.info",
            get: vi.fn(() => `Bearer ${authentication.accessToken}`),
          },
          state,
          cache: {},
        },
        vi.fn()
      );
      expect(state.auth.user.id).toEqual(user.id);
    });

    it("should return error with invalid scope", async () => {
      const state = {} as DefaultState;
      const user = await buildUser();
      const authMiddleware = auth();
      const authentication = await buildOAuthAuthentication({
        user,
        scope: [Scope.Read],
      });

      try {
        await authMiddleware(
          {
            originalUrl: "/api/documents.create",
            // @ts-expect-error mock request
            request: {
              url: "/documents.create",
              get: vi.fn(() => `Bearer ${authentication.accessToken}`),
            },
            state,
            cache: {},
          },
          vi.fn()
        );
      } catch (e) {
        expect(errToString(e)).toContain(
          "does not have access to this resource"
        );
      }
    });

    it("should return error with OAuth access token in body", async () => {
      const state = {} as DefaultState;
      const user = await buildUser();
      const authMiddleware = auth();
      const authentication = await buildOAuthAuthentication({
        user,
        scope: [Scope.Read],
      });
      try {
        await authMiddleware(
          {
            originalUrl: "/api/users.info",
            request: {
              url: "/users.info",
              // @ts-expect-error mock request
              get: vi.fn(() => null),
              body: {
                token: authentication.accessToken,
              },
            },
            state,
            cache: {},
          },
          vi.fn()
        );
      } catch (e) {
        expect(errToString(e)).toContain(
          "must be passed in the Authorization header"
        );
      }
    });
  });

  it("should return error message if no auth token is available", async () => {
    const state = {} as DefaultState;
    const authMiddleware = auth();

    try {
      await authMiddleware(
        {
          // @ts-expect-error mock request
          request: {
            get: vi.fn(() => "error"),
          },
          state,
          cache: {},
        },
        vi.fn()
      );
    } catch (e) {
      expect(errToString(e)).toBe(
        'Bad Authorization header format. Format is "Authorization: Bearer <token>"'
      );
    }
  });

  it("should allow passing session token in a cookie", async () => {
    const state = {} as DefaultState;
    const user = await buildUser();
    const authMiddleware = auth();
    await authMiddleware(
      {
        request: {
          // @ts-expect-error mock request
          get: vi.fn(() => null),
        },
        // @ts-expect-error mock cookies
        cookies: {
          get: vi.fn(() => user.getSessionToken()),
        },
        state,
        cache: {},
      },
      vi.fn()
    );
    expect(state.auth.user.id).toEqual(user.id);
  });

  describe("on the vault apex", () => {
    // Read at run time: the test setup configures env.URL after collection.
    const apexHost = () => parseDomain(env.URL).host;

    function mockVaultMode() {
      return vi.spyOn(Team, "count").mockImplementation(async (options) => {
        const filtered = !!options?.where;
        return filtered ? 0 : 2;
      });
    }

    beforeEach(() => {
      resetVaultModeCache();
    });

    it("should reject a session cookie", async () => {
      const spy = mockVaultMode();
      const user = await buildUser();
      const authMiddleware = auth();

      await expect(
        authMiddleware(
          {
            hostname: apexHost(),
            request: {
              // @ts-expect-error mock request
              get: vi.fn(() => null),
            },
            // @ts-expect-error mock cookies
            cookies: {
              get: vi.fn(() => user.getSessionToken()),
            },
            state: {} as DefaultState,
            cache: {},
          },
          vi.fn()
        )
      ).rejects.toThrow(
        "Workspace sessions are not valid on the vault entry point"
      );
      spy.mockRestore();
    });

    it("should still accept a session token in the Authorization header", async () => {
      const spy = mockVaultMode();
      const state = {} as DefaultState;
      const user = await buildUser();
      const authMiddleware = auth();

      await authMiddleware(
        {
          hostname: apexHost(),
          // @ts-expect-error mock request
          request: {
            get: vi.fn(() => `Bearer ${user.getSessionToken()}`),
          },
          state,
          cache: {},
        },
        vi.fn()
      );
      expect(state.auth.user.id).toEqual(user.id);
      spy.mockRestore();
    });

    it("should accept a session cookie on a tenant subdomain", async () => {
      const spy = mockVaultMode();
      const state = {} as DefaultState;
      const user = await buildUser();
      const authMiddleware = auth();

      await authMiddleware(
        {
          hostname: `tin.${getBaseDomain()}`,
          request: {
            // @ts-expect-error mock request
            get: vi.fn(() => null),
          },
          // @ts-expect-error mock cookies
          cookies: {
            get: vi.fn(() => user.getSessionToken()),
          },
          state,
          cache: {},
        },
        vi.fn()
      );
      expect(state.auth.user.id).toEqual(user.id);
      spy.mockRestore();
    });
  });

  it("should return error with session token as a GET param", async () => {
    const state = {} as DefaultState;
    const user = await buildUser();
    const authMiddleware = auth();

    await expect(
      authMiddleware(
        {
          request: {
            // @ts-expect-error mock request
            get: vi.fn(() => null),
            query: {
              token: user.getSessionToken(),
            },
          },
          state,
          cache: {},
        },
        vi.fn()
      )
    ).rejects.toThrow(
      "Session token must be passed in the cookie or Authorization header"
    );
  });

  it("should return error with session token in body params", async () => {
    const state = {} as DefaultState;
    const user = await buildUser();
    const authMiddleware = auth();

    await expect(
      authMiddleware(
        {
          request: {
            // @ts-expect-error mock request
            get: vi.fn(() => null),
            body: {
              token: user.getSessionToken(),
            },
          },
          state,
          cache: {},
        },
        vi.fn()
      )
    ).rejects.toThrow(
      "Session token must be passed in the cookie or Authorization header"
    );
  });

  it("should allow passing transfer token as a GET param", async () => {
    const state = {} as DefaultState;
    const user = await buildUser();
    const authMiddleware = auth();
    await authMiddleware(
      {
        request: {
          // @ts-expect-error mock request
          get: vi.fn(() => null),
          query: {
            token: user.getTransferToken(),
          },
        },
        state,
        cache: {},
      },
      vi.fn()
    );
    expect(state.auth.user.id).toEqual(user.id);
  });

  it("should return an error for suspended users", async () => {
    const state = {} as DefaultState;
    const admin = await buildAdmin();
    const user = await buildUser({
      suspendedAt: new Date(),
      suspendedById: admin.id,
    });
    const authMiddleware = auth();
    let error;

    try {
      await authMiddleware(
        {
          // @ts-expect-error mock request
          request: {
            get: vi.fn(() => `Bearer ${user.getSessionToken()}`),
          },
          state,
          cache: {},
        },
        vi.fn()
      );
    } catch (err) {
      error = err;
    }

    expect(errToString(error)).toEqual(
      "Your access has been suspended by a workspace admin"
    );
    expect(error).toHaveProperty("errorData.adminEmail", admin.email);
  });

  it("should return an error for deleted team", async () => {
    const state = {} as DefaultState;
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    await team.destroy();
    const authMiddleware = auth();
    let error;

    try {
      await authMiddleware(
        {
          // @ts-expect-error mock request
          request: {
            get: vi.fn(() => `Bearer ${user.getSessionToken()}`),
          },
          state,
          cache: {},
        },
        vi.fn()
      );
    } catch (err) {
      error = err;
    }

    expect(errToString(error)).toEqual("Invalid token");
  });
  describe("with skip", () => {
    it("should ignore credentials when skip returns true", async () => {
      const state = {} as DefaultState;
      const user = await buildUser();
      const apiKey = await buildApiKey({
        userId: user.id,
        scope: ["/api/documents.info"],
      });
      const next = vi.fn();
      const authMiddleware = auth({
        optional: true,
        skip: (ctx) => !!ctx.query.sig,
      });
      await authMiddleware(
        {
          // @ts-expect-error mock request
          request: {
            get: vi.fn(() => `Bearer ${apiKey.value}`),
          },
          query: { sig: "signature" },
          originalUrl: "/api/files.get?sig=signature",
          state,
          cache: {},
        },
        next
      );
      expect(next).toHaveBeenCalled();
      expect(state.auth).toEqual({});
    });

    it("should authenticate when skip returns false", async () => {
      const state = {} as DefaultState;
      const user = await buildUser();
      const next = vi.fn();
      const authMiddleware = auth({
        optional: true,
        skip: (ctx) => !!ctx.query.sig,
      });
      await authMiddleware(
        {
          // @ts-expect-error mock request
          request: {
            get: vi.fn(() => `Bearer ${user.getSessionToken()}`),
          },
          query: {},
          state,
          cache: {},
        },
        next
      );
      expect(next).toHaveBeenCalled();
      expect(state.auth.user.id).toEqual(user.id);
    });
  });

  describe("request transaction", () => {
    /** Runs the middleware inside a request context, as the API router does. */
    async function run(next: (t: Transaction) => Promise<void>) {
      const user = await buildUser();
      const spies: {
        commit?: MockInstance<Transaction["commit"]>;
        rollback?: MockInstance<Transaction["rollback"]>;
      } = {};
      const store = { req: new IncomingMessage(new Socket()) };
      const result = requestContext.run(store, () =>
        auth()(
          {
            // @ts-expect-error mock request
            request: {
              get: vi.fn(() => `Bearer ${user.getSessionToken()}`),
            },
            state: {} as DefaultState,
            cache: {},
          },
          async () => {
            const t = requestContext.getStore()?.transaction;
            expect(t).toBeDefined();
            if (!t) {
              return;
            }
            spies.commit = vi.spyOn(t, "commit");
            spies.rollback = vi.spyOn(t, "rollback");
            await next(t);
          }
        )
      );
      return { result, spies };
    }

    it("commits once after the route when it is not released", async () => {
      const { result, spies } = await run(async () => undefined);
      await expect(result).resolves.toBeUndefined();
      expect(spies.commit).toHaveBeenCalledTimes(1);
      expect(spies.rollback).not.toHaveBeenCalled();
    });

    it("rolls back and rethrows when the route throws", async () => {
      const { result, spies } = await run(async () => {
        throw new Error("route failed");
      });
      await expect(result).rejects.toThrow("route failed");
      expect(spies.commit).not.toHaveBeenCalled();
      expect(spies.rollback).toHaveBeenCalledTimes(1);
    });

    it("does not commit again when the route released it early", async () => {
      const { result, spies } = await run(async () => {
        await releaseRequestTransaction();
      });
      await expect(result).resolves.toBeUndefined();
      expect(spies.commit).toHaveBeenCalledTimes(1);
      expect(spies.rollback).not.toHaveBeenCalled();
    });

    it("surfaces the route's own error after an early release", async () => {
      const { result, spies } = await run(async () => {
        await releaseRequestTransaction();
        throw new Error("route failed");
      });
      await expect(result).rejects.toThrow("route failed");
      expect(spies.commit).toHaveBeenCalledTimes(1);
      expect(spies.rollback).not.toHaveBeenCalled();
    });

    it("commits both transactions once when auth() is nested", async () => {
      // api.batch dispatches each sub-request through its own auth() inside
      // the parent's, so each auth() must settle the transaction it created.
      const user = await buildUser();
      const ctx = () => ({
        request: {
          get: vi.fn(() => `Bearer ${user.getSessionToken()}`),
        },
        state: {} as DefaultState,
        cache: {},
      });
      const commits: MockInstance<Transaction["commit"]>[] = [];
      const rollbacks: MockInstance<Transaction["rollback"]>[] = [];
      const spyOnCurrent = () => {
        const t = requestContext.getStore()?.transaction;
        expect(t).toBeDefined();
        if (t) {
          commits.push(vi.spyOn(t, "commit"));
          rollbacks.push(vi.spyOn(t, "rollback"));
        }
      };
      const store = { req: new IncomingMessage(new Socket()) };

      await requestContext.run(store, () =>
        // @ts-expect-error mock request
        auth()(ctx(), async () => {
          spyOnCurrent();
          // @ts-expect-error mock request
          await auth()(ctx(), async () => {
            spyOnCurrent();
          });
        })
      );

      expect(commits).toHaveLength(2);
      for (const commit of commits) {
        expect(commit).toHaveBeenCalledTimes(1);
      }
      for (const rollback of rollbacks) {
        expect(rollback).not.toHaveBeenCalled();
      }
    });
  });
});
