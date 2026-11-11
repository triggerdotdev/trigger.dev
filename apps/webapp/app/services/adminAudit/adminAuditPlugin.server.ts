import type {
  AdminAuditController,
  AdminAuditPlugin,
  AdminAuditPluginConfig,
} from "@trigger.dev/plugins";

const MODULE_NAME = "@triggerdotdev/plugins/admin-audit";

/** Null means admin audit is off. There is no host fallback: without the plugin nothing is recorded. */
export async function loadAdminAuditPlugin(
  config: AdminAuditPluginConfig,
  options: { requirePlugins: boolean }
): Promise<AdminAuditController | null> {
  try {
    const module = (await import(/* @vite-ignore */ MODULE_NAME)) as {
      default: AdminAuditPlugin;
    };
    return module.default.create(config);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const message = error instanceof Error ? error.message : String(error);
    const isPluginMissing =
      (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
      (message.includes(`'${MODULE_NAME}'`) || message.includes("'@triggerdotdev/plugins'"));

    if (options.requirePlugins) {
      throw new Error(`REQUIRE_PLUGINS=1 but plugin "${MODULE_NAME}" did not load: ${message}`, {
        cause: error,
      });
    }
    if (!isPluginMissing) {
      console.error("Admin audit: plugin found but failed to load; admin audit is off", error);
    }
    return null;
  }
}
