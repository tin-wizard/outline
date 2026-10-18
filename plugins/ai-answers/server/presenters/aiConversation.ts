import type { AIConversation } from "@server/models";
import type { PresentedTurn } from "../history";

/**
 * Presents a stored AI conversation to its owner. Owner and team ids are left
 * out; turns are only included when given, already re-authorised.
 *
 * @param conversation the conversation.
 * @param turns the re-authorised turns, for `aiConversations.info`.
 * @returns the API representation.
 */
export function presentAIConversation(
  conversation: AIConversation,
  turns?: PresentedTurn[]
) {
  return {
    id: conversation.id,
    title: conversation.title,
    pinnedAt: conversation.pinnedAt,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    ...(turns ? { turns } : {}),
  };
}
