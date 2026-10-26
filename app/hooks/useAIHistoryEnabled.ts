import { TeamPreference } from "@shared/types";
import useAIAnswersEnabled from "~/hooks/useAIAnswersEnabled";
import useCurrentTeam from "~/hooks/useCurrentTeam";

/**
 * Whether conversation history can be used: AI answers are available to the
 * user and the workspace keeps history (default off; admins opt in).
 *
 * @param input.aiEnabled whether AI answers are available to the user.
 * @param input.preference the workspace's AIConversationHistory preference.
 * @returns true when chats are stored and listed for this user.
 */
export function canUseAIHistory(input: {
  aiEnabled: boolean;
  preference: boolean;
}): boolean {
  return input.aiEnabled && input.preference;
}

/**
 * Hook form of `canUseAIHistory` for the current team and user. Call it from
 * an observer component so preference changes update the view.
 *
 * @returns true when AI chat history is available to the current user.
 */
export default function useAIHistoryEnabled(): boolean {
  const team = useCurrentTeam();
  const aiEnabled = useAIAnswersEnabled();
  return canUseAIHistory({
    aiEnabled,
    preference: !!team.getPreference(TeamPreference.AIConversationHistory),
  });
}
