import type { Next } from "koa";
import { capitalize } from "es-toolkit/compat";
import httpErrors from "http-errors";
import type { UserRole } from "@shared/types";
import { UserRoleHelper } from "@shared/utils/UserRoleHelper";
import tracer, {
  addTags,
  getRootSpanFromRequestContext,
} from "@server/logging/tracer";
import { User, Team, ApiKey, OAuthAuthentication } from "@server/models";
import { requestContext } from "@server/storage/requestContext";
import type { AppContext } from "@server/types";
import { AuthenticationType } from "@server/types";
import { getJWTPayload, getUserForJWT } from "@server/utils/jwt";
import {
  AuthenticationError,
  AuthorizationError,
  UserSuspendedError,
} from "../errors";

type BaseAuthenticationOptions = {
  /** Role required to access the route. */
  role?: UserRole;
  /** Type of authentication required to access the route. */
  type?: AuthenticationType | AuthenticationType[];
};

type AuthenticationOptions =
  | (BaseAuthenticationOptions & {
      /** Authentication is required. */
      optional?: false;
      skip?: never;
    })
  | (BaseAuthenticationOptions & {
      /** Authentication is parsed, but optional. */
      optional: true;
      /**
       * Returns true when the request is authorized by other means, in which
       * case any credentials on the request are ignored rather than parsed.
       */
      skip?: (ctx: AppContext) => boolean;
    });

type AuthTransport = "cookie" | "header" | "body" | "query";

type AuthInput = {
  /** The authentication token extracted from the request, if any. */
  token?: string;
  /** The method used to receive the authentication token. */
  transport?: AuthTransport;
};

export default function auth(options: AuthenticationOptions = {}) {
  return async function authMiddleware(ctx: AppContext, next: Next) {
    if (options.skip?.(ctx)) {
      ctx.state.auth = {};
      return next();
    }

    try {
      const { type, token, user, service, scope } =
        await validateAuthentication(ctx, options);

      await Promise.all([
        user.updateActiveAt(ctx),
        user.team?.updateActiveAt(),
      ]);

      ctx.state.auth = {
        user,
        token,
        type,
        service,
        scope,
      };

      // Publish the tenant for the current request so database transactions can
      // set `app.team_id` for row-level security. Only set when the request is
      // inside an HTTP request context.
      const store = requestContext.getStore();
      if (store) {
        store.tenant = {
          teamId: user.teamId,
          isPlatformAdmin: user.isPlatformAdmin,
        };
      }

      if (tracer) {
        addTags(
          {
            "request.userId": user.id,
            "request.teamId": user.teamId,
            "request.authType": type,
          },
          getRootSpanFromRequestContext(ctx)
        );
      }
    } catch (err) {
      // Credentials that are valid but insufficient are always surfaced,
      // otherwise the request would be silently downgraded to anonymous.
      if (options.optional && !(err instanceof httpErrors.Forbidden)) {
        ctx.state.auth = {};
      } else {
        throw err;
      }
    }

    const store = requestContext.getStore();
    const tenant = store?.tenant;

    // When running inside an HTTP request with a resolved tenant, wrap the
    // remainder of the request in a tenant-scoped transaction so row-level
    // security also applies to reads (which otherwise run against the shared
    // connection pool with no per-request tenant context). The transaction is
    // pinned to the request and injects `app.team_id` on begin, so every query
    // issued during the request inherits the tenant that RLS enforces against.
    // It is committed once the route completes, releasing the pinned connection.
    //
    // Requests without a tenant (anonymous/public) and non-HTTP contexts
    // (workers, collaboration) skip this wrapper: they rely on the transaction
    // wrapper alone, where RLS stays default-allow.
    //
    // `sequelize` is imported at runtime rather than at module load: this module
    // is loaded during model registration, and a static import of the shared
    // instance would re-enter the storage/database initializer before it has
    // built the singleton, creating a second, partially-mapped instance.
    if (store && tenant) {
      const { sequelize } = await import("@server/storage/database");
      const t = await sequelize.transaction();
      store.transaction = t;
      try {
        await next();
        // A route may have committed it early (releaseRequestTransaction).
        if (store.transaction === t) {
          await t.commit();
        }
      } catch (err) {
        if (store.transaction === t) {
          await t.rollback().catch(() => undefined);
        }
        throw err;
      }
      return;
    }

    return next();
  };
}

/**
 * Parses the authentication token from the request context.
 *
 * @param ctx The application context containing the request information.
 * @returns An object containing the token and its transport method.
 */
export function parseAuthentication(ctx: AppContext): AuthInput {
  const authorizationHeader = ctx.request.get("authorization");

  if (authorizationHeader) {
    const parts = authorizationHeader.split(" ");

    if (parts.length === 2) {
      const scheme = parts[0];
      const credentials = parts[1];

      if (/^Bearer$/i.test(scheme)) {
        return {
          token: credentials,
          transport: "header",
        };
      }
    } else {
      throw AuthenticationError(
        `Bad Authorization header format. Format is "Authorization: Bearer <token>"`
      );
    }
  } else if (
    ctx.request.body &&
    typeof ctx.request.body === "object" &&
    "token" in ctx.request.body
  ) {
    return {
      token: String(ctx.request.body.token),
      transport: "body",
    };
  } else if (ctx.request.query?.token) {
    return {
      token: String(ctx.request.query.token),
      transport: "query",
    };
  } else {
    const accessToken = ctx.cookies.get("accessToken");
    if (accessToken) {
      return {
        token: accessToken,
        transport: "cookie",
      };
    }
  }

  return {
    token: undefined,
    transport: undefined,
  };
}

async function validateAuthentication(
  ctx: AppContext,
  options: AuthenticationOptions
): Promise<{
  user: User;
  token: string;
  type: AuthenticationType;
  service?: string;
  scope?: string[];
}> {
  const { token, transport } = parseAuthentication(ctx);

  if (!token) {
    throw AuthenticationError("Authentication required");
  }

  let user: User | null;
  let type: AuthenticationType;
  let service: string | undefined;
  let scope: string[] | undefined;

  if (OAuthAuthentication.match(token)) {
    if (transport !== "header") {
      throw AuthenticationError(
        "OAuth access token must be passed in the Authorization header"
      );
    }

    type = AuthenticationType.OAUTH;

    let authentication;
    try {
      authentication = await OAuthAuthentication.findByAccessToken(token, {
        rejectOnEmpty: true,
      });
    } catch (_err) {
      throw AuthenticationError("Invalid access token");
    }
    if (!authentication) {
      throw AuthenticationError("Invalid access token");
    }
    if (authentication.accessTokenExpiresAt < new Date()) {
      throw AuthenticationError("Access token is expired");
    }
    if (!authentication.canAccess(ctx.originalUrl)) {
      throw AuthorizationError(
        "Access token does not have access to this resource"
      );
    }

    user = await User.findByPk(authentication.userId, {
      include: [
        {
          model: Team,
          as: "team",
          required: true,
        },
      ],
    });
    if (!user) {
      throw AuthenticationError("Invalid access token");
    }

    scope = authentication.scope;
    await authentication.updateActiveAt();
  } else if (ApiKey.match(token)) {
    if (transport === "cookie") {
      throw AuthenticationError("API key must not be passed in the cookie");
    }

    type = AuthenticationType.API;
    let apiKey;

    try {
      apiKey = await ApiKey.findByToken(token);
    } catch (_err) {
      throw AuthenticationError("Invalid API key");
    }

    if (!apiKey) {
      throw AuthenticationError("Invalid API key");
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      throw AuthenticationError("API key is expired");
    }

    if (!apiKey.canAccess(ctx.originalUrl)) {
      throw AuthorizationError("API key does not have access to this resource");
    }

    user = await User.findByPk(apiKey.userId, {
      include: [
        {
          model: Team,
          as: "team",
          required: true,
        },
      ],
    });

    if (!user) {
      throw AuthenticationError("Invalid API key");
    }

    scope = apiKey.scope ?? ["*"];
    await apiKey.updateActiveAt();
  } else {
    // Session tokens are long-lived, so keep them out of transports that end up
    // in browser history, referrers, and request logs. Short-lived single-use
    // tokens such as transfer are still accepted from anywhere.
    if (transport !== "cookie" && transport !== "header") {
      const payload = getJWTPayload(token);

      if (payload.type === "session") {
        throw AuthenticationError(
          "Session token must be passed in the cookie or Authorization header"
        );
      }
    }

    // The vault apex is identity-only and never hosts a workspace, so a
    // workspace session cookie there (e.g. from before vault mode) must not
    // load the app. API keys and OAuth tokens arrive in the header and are
    // unaffected. Imported at runtime because this module loads during model
    // registration.
    if (transport === "cookie" && ctx.hostname) {
      const { isVaultRequest } = await import("@server/utils/vault");

      if (await isVaultRequest(ctx)) {
        throw AuthenticationError(
          "Workspace sessions are not valid on the vault entry point"
        );
      }
    }

    type = AuthenticationType.APP;
    const result = await getUserForJWT(token);
    user = result.user;
    service = result.service;
  }

  if (user.isSuspended) {
    const suspendingAdmin = user.suspendedById
      ? await User.findByPk(user.suspendedById)
      : undefined;
    throw UserSuspendedError({
      adminEmail: suspendingAdmin?.email || undefined,
    });
  }

  if (options.role && UserRoleHelper.isRoleLower(user.role, options.role)) {
    throw AuthorizationError(`${capitalize(options.role)} role required`);
  }

  if (
    options.type &&
    (Array.isArray(options.type)
      ? !options.type.includes(type)
      : type !== options.type)
  ) {
    throw AuthorizationError(`Invalid authentication type`);
  }

  return {
    user,
    type,
    token,
    service,
    scope,
  };
}
