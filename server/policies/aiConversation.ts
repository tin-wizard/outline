import { AIConversation, User } from "@server/models";
import { allow } from "./cancan";

// Owner only: no admin override, admins never read others' conversations.
allow(
  User,
  ["read", "update", "delete"],
  AIConversation,
  (actor, conversation) =>
    !!conversation &&
    actor.id === conversation.userId &&
    actor.teamId === conversation.teamId
);
