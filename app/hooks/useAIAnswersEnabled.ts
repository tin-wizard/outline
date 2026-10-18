import { TeamPreference } from "@shared/types";
import env from "~/env";
import useCurrentTeam from "~/hooks/useCurrentTeam";
import useCurrentUser from "~/hooks/useCurrentUser";

/**
 * Whether AI answers can be used: the server offers them, the workspace turned
 * them on, and the user is a member or admin (guests and viewers get a 403).
 *
 * @param input.available the server's AI_ANSWERS_ENABLED setting.
 * @param input.preference the workspace's AIAnswers preference.
 * @param input.isGuest whether the user is a guest.
 * @param input.isViewer whether the user is a viewer.
 * @returns true when AI answers are available to this user.
 */
export function canUseAIAnswers(input: {
  available: boolean;
  preference: boolean;
  isGuest: boolean;
  isViewer: boolean;
}): boolean {
  return (
    input.available && input.preference && !input.isGuest && !input.isViewer
  );
}

/**
 * Hook form of `canUseAIAnswers` for the current team and user. Call it from
 * an observer component so preference changes update the view.
 *
 * @returns true when AI answers are available to the current user.
 */
export default function useAIAnswersEnabled(): boolean {
  const team = useCurrentTeam();
  const user = useCurrentUser();
  return canUseAIAnswers({
    available: env.AI_ANSWERS_ENABLED === true,
    preference: !!team.getPreference(TeamPreference.AIAnswers),
    isGuest: user.isGuest,
    isViewer: user.isViewer,
  });
}
