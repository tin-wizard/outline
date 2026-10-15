import { Hook, PluginManager } from "@server/utils/PluginManager";
import config from "../plugin.json";
import pages from "./api/pages";
import env from "./env";
import { registerSentryScrubber } from "./lib/sentry";
import CleanupPagesInsightsTask from "./tasks/CleanupPagesInsightsTask";
import RollupPagesInsightsTask from "./tasks/RollupPagesInsightsTask";

if (env.PAGES_ENABLED) {
  registerSentryScrubber();
  PluginManager.add([
    {
      ...config,
      type: Hook.API,
      value: pages,
    },
    {
      type: Hook.Task,
      value: RollupPagesInsightsTask,
    },
    {
      type: Hook.Task,
      value: CleanupPagesInsightsTask,
    },
  ]);
}
