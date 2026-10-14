import { createLazyComponent } from "~/components/LazyLoad";
import env from "~/env";
import { Hook, PluginManager } from "~/utils/PluginManager";
import config from "../plugin.json";
import Icon from "./Icon";

PluginManager.add([
  {
    ...config,
    type: Hook.Settings,
    value: {
      group: "Workspace",
      after: "Shared Links",
      icon: Icon,
      description: "Publish gated pages to Cloudflare R2 from Settings.",
      component: createLazyComponent(() => import("./Settings")),
      enabled: (_, user) =>
        env.PAGES_ENABLED === true && (user.isAdmin || !!user.isPlatformAdmin),
    },
  },
]);
