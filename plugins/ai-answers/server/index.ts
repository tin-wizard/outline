import { PluginManager, Hook } from "@server/utils/PluginManager";
import config from "../plugin.json";
import router from "./api/answers";
import askRouter from "./api/ask";
import env from "./env";

if (env.ANTHROPIC_API_KEY) {
  PluginManager.add([
    { ...config, type: Hook.API, value: router },
    { ...config, type: Hook.API, value: askRouter },
  ]);
}
