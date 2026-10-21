import Router from "koa-router";
import { Op, type WhereOptions } from "sequelize";
import { UserRole } from "@shared/types";
import teamCreator from "@server/commands/teamCreator";
import InviteEmail from "@server/emails/templates/InviteEmail";
import env from "@server/env";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import { transaction } from "@server/middlewares/transaction";
import validate from "@server/middlewares/validate";
import { Collection, Team, User, UserMembership } from "@server/models";
import { authorize } from "@server/policies";
import { presentTeam, presentUser } from "@server/presenters";
import { UserFlag } from "@server/models/User";
import { QueryHelper } from "@server/storage/QueryHelper";
import { sequelize } from "@server/storage/database";
import type { APIContext } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import pagination from "../middlewares/pagination";
import * as T from "./schema";

const router = new Router();

/**
 * Platform (ops) console: manage tenants across the whole deployment.
 *
 * All endpoints require the request to be authorized against the platform
 * capability by the caller (see `authorizeOperation`). Every tenant is a
 * `Team`; the ops console creates and lists them so each company gets its own
 * isolated subdomain-backed workspace.
 */
router.post(
  "ops.teams.list",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  transaction(),
  async (ctx: APIContext) => {
    const { user } = ctx.state.auth;
    authorize(user, "manageOps", user.team);

    const [teams, userCounts] = await Promise.all([
      Team.scope("withDomains").findAll({
        order: [["createdAt", "ASC"]],
      }),
      User.findAll({
        attributes: [
          "teamId",
          [sequelize.fn("COUNT", sequelize.col("id")), "count"],
        ],
        group: ["teamId"],
        raw: true,
        paranoid: false,
      }),
    ]);

    const countsByTeam = new Map(
      (
        userCounts as unknown as Array<{
          teamId: string;
          count: string | number;
        }>
      ).map((row) => [`${row.teamId}`, Number(row.count)])
    );

    ctx.body = {
      data: teams.map((team) => ({
        ...presentTeam(team),
        userCount: countsByTeam.get(team.id) ?? 0,
      })),
    };
  }
);

router.post(
  "ops.teams.create",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  validate(T.OpsTeamCreateSchema),
  transaction(),
  async (ctx: APIContext<T.OpsTeamCreateSchemaReq>) => {
    const { user } = ctx.state.auth;
    authorize(user, "manageOps", user.team);

    const { name, subdomain, adminEmail } = ctx.input.body;
    const team = await teamCreator(ctx, {
      name,
      subdomain:
        subdomain ||
        name
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, ""),
      authenticationProviders: [],
    });

    // Optionally provision the first admin user and send them an invite
    if (adminEmail) {
      const adminUser = await User.createWithCtx(
        ctx,
        {
          teamId: team.id,
          name: adminEmail.split("@")[0],
          email: adminEmail.toLowerCase(),
          role: UserRole.Admin,
          isViewer: false,
          invitedById: user.id,
          inviteLastSentAt: new Date(),
          flags: {
            [UserFlag.InviteSent]: 1,
          },
        },
        undefined
      );

      // Send invitation email so the new admin can sign in via the magic link
      await new InviteEmail({
        to: adminEmail.toLowerCase(),
        name: adminUser.name,
        actorName: user.name,
        actorEmail: user.email,
        teamName: team.name,
        teamUrl: `${env.URL.replace("://", `://${team.subdomain}.`)}`,
        language: adminUser.language,
        token: adminUser.getInviteToken(),
      }).schedule();
    }

    ctx.body = {
      data: presentTeam(team),
    };
  }
);

router.post(
  "ops.users.setPlatformAdmin",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  validate(T.OpsUserSetPlatformAdminSchema),
  transaction(),
  async (ctx: APIContext<T.OpsUserSetPlatformAdminSchemaReq>) => {
    const { user } = ctx.state.auth;
    authorize(user, "manageOps", user.team);

    const { userId, platformAdmin } = ctx.input.body;
    const target = await User.findByPk(userId, { rejectOnEmpty: true });

    // Platform Admin outranks every workspace role: granting it ensures the
    // target holds at least Admin in their own workspace.
    if (platformAdmin && target.role !== UserRole.Admin) {
      target.role = UserRole.Admin;
    }
    target.setFlag(UserFlag.PlatformAdmin, platformAdmin);
    await target.save();

    ctx.body = {
      data: presentUser(target, { includeDetails: true }),
    };
  }
);

router.post(
  "ops.teams.update",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  validate(T.OpsTeamUpdateSchema),
  transaction(),
  async (ctx: APIContext<T.OpsTeamUpdateSchemaReq>) => {
    const { user } = ctx.state.auth;
    authorize(user, "manageOps", user.team);

    const { id, name, subdomain } = ctx.input.body;
    const team = await Team.findByPk(id, { rejectOnEmpty: true });

    if (name) {
      team.name = name;
    }
    if (subdomain) {
      team.subdomain = subdomain;
    }
    await team.save();

    ctx.body = {
      data: presentTeam(team),
    };
  }
);

router.post(
  "ops.teams.delete",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  validate(T.OpsTeamDeleteSchema),
  transaction(),
  async (ctx: APIContext<T.OpsTeamDeleteSchemaReq>) => {
    const { user } = ctx.state.auth;
    authorize(user, "manageOps", user.team);

    const { id } = ctx.input.body;

    // Safety: never allow deleting the platform admin's own team
    if (id === user.teamId) {
      ctx.throw(
        400,
        "Cannot delete the workspace you are currently logged into"
      );
    }

    const team = await Team.findByPk(id, { rejectOnEmpty: true });
    await team.destroy();

    ctx.body = { ok: true };
  }
);

/**
 * Enter a tenant workspace as its admin (super-admin impersonation).
 *
 * Finds or provisions an account for the operator inside the target team
 * with the Admin role, then returns a single-use email sign-in URL that
 * logs the operator into that team's subdomain in a new browser tab.
 */
router.post(
  "ops.teams.impersonate",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  validate(T.OpsTeamImpersonateSchema),
  transaction(),
  async (ctx: APIContext<T.OpsTeamImpersonateSchemaReq>) => {
    const { user } = ctx.state.auth;
    authorize(user, "manageOps", user.team);

    const { id } = ctx.input.body;
    const team = await Team.findByPk(id, { rejectOnEmpty: true });

    // Find or create the operator's account inside the target team. Platform
    // admins outrank workspace roles, so the account is always an Admin.
    let target = await User.findOne({
      where: { teamId: team.id, email: user.email },
    });

    if (!target) {
      target = await User.createWithCtx(
        ctx,
        {
          teamId: team.id,
          name: user.name,
          email: user.email,
          role: UserRole.Admin,
        },
        undefined
      );
    } else if (target.role !== UserRole.Admin) {
      target.role = UserRole.Admin;
      await target.saveWithCtx(ctx);
    }

    const token = target.getEmailSigninToken(ctx);
    ctx.body = {
      data: {
        url: `${team.url}/auth/email.callback?token=${token}`,
      },
    };
  }
);

/**
 * List users across every workspace on the deployment.
 *
 * Results can be narrowed by a name or email search, a workspace, or a role,
 * and are paginated.
 */
router.post(
  "ops.users.list",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  validate(T.OpsUsersListSchema),
  pagination(),
  transaction(),
  async (ctx: APIContext<T.OpsUsersListSchemaReq>) => {
    const { user } = ctx.state.auth;
    authorize(user, "manageOps", user.team);

    const { query, teamId, role } = ctx.input.body;
    const where: WhereOptions<User> = {
      ...(query && {
        [Op.or]: [
          { name: { [Op.iLike]: QueryHelper.likeContains(query) } },
          { email: { [Op.iLike]: QueryHelper.likeContains(query) } },
        ],
      }),
      ...(teamId && { teamId }),
      ...(role && { role }),
    };

    const [users, total] = await Promise.all([
      User.findAll({
        where,
        include: [
          {
            model: Team,
            as: "team",
            attributes: ["id", "name", "subdomain", "suspendedAt"],
          },
        ],
        order: [
          ["name", "ASC"],
          ["id", "ASC"],
        ],
        offset: ctx.state.pagination.offset,
        limit: ctx.state.pagination.limit,
      }),
      User.count({ where }),
    ]);

    ctx.body = {
      pagination: { ...ctx.state.pagination, total },
      data: users.map((target) => ({
        ...presentUser(target, { includeDetails: true }),
        team: {
          id: target.team.id,
          name: target.team.name,
          subdomain: target.team.subdomain,
        },
      })),
    };
  }
);

/**
 * Change the workspace role of any user on the deployment.
 *
 * Platform Admin outranks every workspace role, so a platform admin must keep
 * the Admin role.
 *
 * @throws 400 if the target is a platform admin and the role is not Admin.
 */
router.post(
  "ops.users.setRole",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  validate(T.OpsUserSetRoleSchema),
  transaction(),
  async (ctx: APIContext<T.OpsUserSetRoleSchemaReq>) => {
    const { user } = ctx.state.auth;
    authorize(user, "manageOps", user.team);

    const { userId, role } = ctx.input.body;
    const target = await User.findByPk(userId, { rejectOnEmpty: true });

    if (target.isPlatformAdmin && role !== UserRole.Admin) {
      ctx.throw(400, "Platform admins must keep the Admin role");
    }

    target.role = role;
    await target.save();

    ctx.body = {
      data: presentUser(target, { includeDetails: true }),
    };
  }
);

/**
 * List collections across every workspace on the deployment.
 *
 * Results can be narrowed by a name search or a workspace, and are paginated.
 */
router.post(
  "ops.collections.list",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  validate(T.OpsCollectionsListSchema),
  pagination(),
  transaction(),
  async (ctx: APIContext<T.OpsCollectionsListSchemaReq>) => {
    const { user } = ctx.state.auth;
    authorize(user, "manageOps", user.team);

    const { query, teamId } = ctx.input.body;
    const where: WhereOptions<Collection> = {};

    if (query) {
      where.name = { [Op.iLike]: QueryHelper.likeContains(query) };
    }
    if (teamId) {
      where.teamId = teamId;
    }

    const [collections, total] = await Promise.all([
      Collection.findAll({
        where,
        include: [
          { model: Team, as: "team", attributes: ["id", "name", "subdomain"] },
        ],
        order: [
          ["name", "ASC"],
          ["id", "ASC"],
        ],
        offset: ctx.state.pagination.offset,
        limit: ctx.state.pagination.limit,
      }),
      Collection.count({ where }),
    ]);

    ctx.body = {
      pagination: { ...ctx.state.pagination, total },
      data: collections.map((collection) => ({
        id: collection.id,
        name: collection.name,
        teamId: collection.teamId,
        team: {
          id: collection.team.id,
          name: collection.team.name,
          subdomain: collection.team.subdomain,
        },
        archivedAt: collection.archivedAt,
        updatedAt: collection.updatedAt,
      })),
    };
  }
);

/**
 * List the direct members of a collection, in any workspace.
 */
router.post(
  "ops.collections.memberships",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  validate(T.OpsCollectionIdSchema),
  transaction(),
  async (ctx: APIContext<T.OpsCollectionIdSchemaReq>) => {
    const { user } = ctx.state.auth;
    authorize(user, "manageOps", user.team);

    const { id } = ctx.input.body;
    await Collection.findByPk(id, { rejectOnEmpty: true });

    const memberships = await UserMembership.findAll({
      where: { collectionId: id },
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "name", "email", "teamId"],
        },
      ],
      order: [["createdAt", "ASC"]],
    });

    ctx.body = {
      data: memberships.map((membership) => ({
        id: membership.id,
        userId: membership.userId,
        permission: membership.permission,
        user: {
          id: membership.user.id,
          name: membership.user.name,
          email: membership.user.email,
          teamId: membership.user.teamId,
        },
      })),
    };
  }
);

/**
 * Add a user to a collection, or update their permission if already a member.
 *
 * The user must belong to the same workspace as the collection.
 *
 * @throws 400 if the user belongs to a different workspace.
 */
router.post(
  "ops.collections.addUser",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  validate(T.OpsCollectionAddUserSchema),
  transaction(),
  async (ctx: APIContext<T.OpsCollectionAddUserSchemaReq>) => {
    const { transaction } = ctx.state;
    const { user: actor } = ctx.state.auth;
    authorize(actor, "manageOps", actor.team);

    const { id, userId, permission } = ctx.input.body;
    const collection = await Collection.findByPk(id, {
      rejectOnEmpty: true,
      transaction,
    });
    const target = await User.findByPk(userId, {
      rejectOnEmpty: true,
      transaction,
    });

    if (target.teamId !== collection.teamId) {
      ctx.throw(
        400,
        "User belongs to a different workspace than the collection"
      );
    }

    let membership = await UserMembership.findOne({
      where: { collectionId: id, userId },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });

    if (membership) {
      membership.permission = permission ?? target.defaultCollectionPermission;
      await membership.save(ctx.context);
    } else {
      membership = await UserMembership.create(
        {
          collectionId: id,
          userId,
          permission: permission ?? target.defaultCollectionPermission,
          createdById: actor.id,
        },
        ctx.context
      );
    }

    ctx.body = {
      data: {
        id: membership.id,
        userId: membership.userId,
        permission: membership.permission,
      },
    };
  }
);

/**
 * Remove a user from a collection, in any workspace.
 *
 * @throws 400 if the user is not a member of the collection.
 */
router.post(
  "ops.collections.removeUser",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  validate(T.OpsCollectionRemoveUserSchema),
  transaction(),
  async (ctx: APIContext<T.OpsCollectionRemoveUserSchemaReq>) => {
    const { transaction } = ctx.state;
    const { user } = ctx.state.auth;
    authorize(user, "manageOps", user.team);

    const { id, userId } = ctx.input.body;
    const membership = await UserMembership.findOne({
      where: { collectionId: id, userId },
      transaction,
    });

    if (!membership) {
      ctx.throw(400, "User is not a member of this collection");
    }

    await membership.destroy(ctx.context);

    ctx.body = {
      success: true,
    };
  }
);

/**
 * Delete any collection on the deployment, along with its documents.
 */
router.post(
  "ops.collections.delete",
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  auth(),
  validate(T.OpsCollectionIdSchema),
  transaction(),
  async (ctx: APIContext<T.OpsCollectionIdSchemaReq>) => {
    const { transaction } = ctx.state;
    const { user } = ctx.state.auth;
    authorize(user, "manageOps", user.team);

    const { id } = ctx.input.body;
    const collection = await Collection.findByPk(id, {
      rejectOnEmpty: true,
      transaction,
    });

    await collection.destroyWithCtx(ctx);

    ctx.body = {
      success: true,
    };
  }
);

export default router;
