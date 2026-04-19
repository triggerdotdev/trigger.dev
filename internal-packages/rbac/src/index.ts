import type { RBACPlugin } from "@trigger.dev/plugins";

export type { RBACPlugin };

type PluginModule = {
  create(): RBACPlugin | Promise<RBACPlugin>;
};

export async function createRBACPlugin(): Promise<RBACPlugin> {
  try {
    // Installed in cloud deployments; absent in OSS
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { create } = require("@triggerdotdev/plugin-rbac") as PluginModule;
    return create();
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { create } = require("./fallback") as PluginModule;
    return create();
  }
}
