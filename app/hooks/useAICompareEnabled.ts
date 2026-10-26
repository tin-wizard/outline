import { TeamPreference } from "@shared/types";
import useAIAnswersEnabled from "~/hooks/useAIAnswersEnabled";
import useCurrentTeam from "~/hooks/useCurrentTeam";

/**
 * Whether the Compare chip is offered in AI Search: AI answers are available
 * to the user and the workspace turned on the `aiCompare` preference
 * (default off). Call it from an observer component.
 *
 * @returns true when questions may be asked in compare mode.
 */
export default function useAICompareEnabled(): boolean {
  const team = useCurrentTeam();
  const aiEnabled = useAIAnswersEnabled();
  return aiEnabled && !!team.getPreference(TeamPreference.AICompare);
}
