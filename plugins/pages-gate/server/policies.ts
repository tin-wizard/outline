import { PagesSite, Team, User } from "@server/models";
import type Model from "@server/models/base/Model";
import { allow } from "@server/policies/cancan";
import { isTeamModel } from "@server/policies/utils";

/**
 * Whether the actor administers the team that owns the model: an admin or a
 * platform admin, in the same team. Platform admins gain no cross-team access.
 *
 * @param actor the user performing the action.
 * @param model the team or team-owned model being acted on.
 * @returns true when the actor may manage gated sites for that team.
 */
export function isPagesAdmin(
  actor: User,
  model: Model | null | undefined
): boolean {
  return (
    isTeamModel(actor, model) &&
    (actor.isAdmin || actor.isPlatformAdmin) &&
    !actor.isSuspended
  );
}

allow(User, ["createPagesSite", "listPagesSite"], Team, isPagesAdmin);

allow(
  User,
  ["read", "update", "publish", "rotate", "unpublish", "delete"],
  PagesSite,
  isPagesAdmin
);
