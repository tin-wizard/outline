import { TeamPreference } from "@shared/types";
import { AuthorizationError } from "@server/errors";
import type { Team, User } from "@server/models";

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

/**
 * Whether AI conversations are kept as history in the workspace: AI answers
 * and the conversation history preference are both on.
 *
 * @param team the workspace.
 * @returns true when conversations are stored.
 */
export function isHistoryEnabled(team: Team): boolean {
  return (
    !!team.getPreference(TeamPreference.AIAnswers) &&
    !!team.getPreference(TeamPreference.AIConversationHistory)
  );
}

/**
 * Throws unless the user may use AI conversation history: AI answers are
 * allowed for them and history is on in the workspace.
 *
 * @param user the authenticated user.
 * @throws AuthorizationError when AI answers or history are not available.
 */
export function assertHistoryAllowed(user: User): void {
  assertAIAnswersAllowed(user);
  if (!isHistoryEnabled(user.team)) {
    throw AuthorizationError("AI conversation history is not enabled");
  }
}
