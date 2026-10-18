import { PluginManager, Hook } from "@server/utils/PluginManager";
import config from "../plugin.json";
import askRouter from "./api/ask";
import conversationsRouter from "./api/conversations";
import documentsRouter from "./api/documents";
import env from "./env";
import CleanupOldAIConversationsTask from "./tasks/CleanupOldAIConversationsTask";

if (env.ANTHROPIC_API_KEY) {
  PluginManager.add([
    { ...config, type: Hook.API, value: askRouter },
    { ...config, type: Hook.API, value: documentsRouter },
  ]);
}

// Stored chats can be listed and deleted, and retention keeps running, even
// when AI answers are not configured any more.
PluginManager.add([
  { ...config, type: Hook.API, value: conversationsRouter },
  { type: Hook.Task, value: CleanupOldAIConversationsTask },
]);
