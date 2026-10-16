import { TeamPreference } from "@shared/types";
import { AuthorizationError } from "@server/errors";
import type { User } from "@server/models";

/**
 * Throws unless the user may use AI answers: the workspace has the AIAnswers
 * preference on, and the user is a member or admin (owner decision D8: no
 * guests or viewers).
 *
 * @param user the authenticated user.
 * @throws AuthorizationError when AI answers are off or the role is excluded.
 */
export function assertAIAnswersAllowed(user: User): void {
  if (!user.team.getPreference(TeamPreference.AIAnswers)) {
    throw AuthorizationError("AI answers are not enabled for this workspace");
  }
  if (user.isGuest || user.isViewer) {
    throw AuthorizationError("AI answers are not available for your role");
  }
}
