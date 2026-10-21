import { z } from "zod";
import { CollectionPermission, UserRole } from "@shared/types";
import { BaseSchema } from "@server/routes/api/schema";

export const OpsTeamCreateSchema = BaseSchema.extend({
  body: z.object({
    /** The displayed name of the tenant/company workspace */
    name: z.string().min(1),
    /** The preferred subdomain for the tenant, slugified and deduplicated (defaults to slug of name) */
    subdomain: z.string().optional(),
    /** Optional email address to provision as the first admin of the new workspace */
    adminEmail: z.string().email().optional(),
  }),
});

export type OpsTeamCreateSchemaReq = z.infer<typeof OpsTeamCreateSchema>;

export const OpsTeamUpdateSchema = BaseSchema.extend({
  body: z.object({
    /** The ID of the team to update */
    id: z.string().uuid(),
    /** New display name */
    name: z.string().min(1).optional(),
    /** New subdomain */
    subdomain: z.string().min(1).optional(),
  }),
});

export type OpsTeamUpdateSchemaReq = z.infer<typeof OpsTeamUpdateSchema>;

export const OpsTeamDeleteSchema = BaseSchema.extend({
  body: z.object({
    /** The ID of the team to delete */
    id: z.string().uuid(),
  }),
});

export type OpsTeamDeleteSchemaReq = z.infer<typeof OpsTeamDeleteSchema>;

export const OpsTeamImpersonateSchema = BaseSchema.extend({
  body: z.object({
    /** The ID of the team to enter as admin */
    id: z.string().uuid(),
  }),
});

export type OpsTeamImpersonateSchemaReq = z.infer<
  typeof OpsTeamImpersonateSchema
>;

export const OpsUserSetPlatformAdminSchema = BaseSchema.extend({
  body: z.object({
    /** The ID of the user to update */
    userId: z.string().uuid(),
    /** Whether to grant or revoke platform admin */
    platformAdmin: z.boolean(),
  }),
});

export type OpsUserSetPlatformAdminSchemaReq = z.infer<
  typeof OpsUserSetPlatformAdminSchema
>;

export const OpsUsersListSchema = BaseSchema.extend({
  body: z.object({
    /** Optional case-insensitive search across user name and email */
    query: z.string().optional(),
    /** Optional workspace ID to restrict results to a single tenant */
    teamId: z.string().uuid().optional(),
    /** Optional workspace role to restrict results to */
    role: z.enum(UserRole).optional(),
  }),
});

export type OpsUsersListSchemaReq = z.infer<typeof OpsUsersListSchema>;

export const OpsUserSetRoleSchema = BaseSchema.extend({
  body: z.object({
    /** The ID of the user to update */
    userId: z.string().uuid(),
    /** The workspace role to assign to the user */
    role: z.enum(UserRole),
  }),
});

export type OpsUserSetRoleSchemaReq = z.infer<typeof OpsUserSetRoleSchema>;

export const OpsCollectionsListSchema = BaseSchema.extend({
  body: z.object({
    /** Optional case-insensitive search across collection names */
    query: z.string().optional(),
    /** Optional workspace ID to restrict results to a single tenant */
    teamId: z.string().uuid().optional(),
  }),
});

export type OpsCollectionsListSchemaReq = z.infer<
  typeof OpsCollectionsListSchema
>;

export const OpsCollectionIdSchema = BaseSchema.extend({
  body: z.object({
    /** The ID of the collection */
    id: z.string().uuid(),
  }),
});

export type OpsCollectionIdSchemaReq = z.infer<typeof OpsCollectionIdSchema>;

export const OpsCollectionAddUserSchema = BaseSchema.extend({
  body: z.object({
    /** The ID of the collection */
    id: z.string().uuid(),
    /** The ID of the user to add, who must belong to the collection's workspace */
    userId: z.string().uuid(),
    /** The permission to grant, defaults to the user's default permission */
    permission: z.enum(CollectionPermission).optional(),
  }),
});

export type OpsCollectionAddUserSchemaReq = z.infer<
  typeof OpsCollectionAddUserSchema
>;

export const OpsCollectionRemoveUserSchema = BaseSchema.extend({
  body: z.object({
    /** The ID of the collection */
    id: z.string().uuid(),
    /** The ID of the user to remove from the collection */
    userId: z.string().uuid(),
  }),
});

export type OpsCollectionRemoveUserSchemaReq = z.infer<
  typeof OpsCollectionRemoveUserSchema
>;
