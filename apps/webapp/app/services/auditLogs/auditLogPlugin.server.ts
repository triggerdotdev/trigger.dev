import type {
  AuditLogController,
  AuditLogPlugin,
  AuditLogPluginConfig,
} from "@trigger.dev/plugins";

const AUDIT_LOG_MODULE_NAME = "@triggerdotdev/plugins/audit";

/** Null means audit logs are off. There is no host fallback: without the plugin nothing is recorded. */
export async function loadAuditLogPlugin(options: {
  requirePlugins: boolean;
  config: AuditLogPluginConfig;
}): Promise<AuditLogController | null> {
  try {
    const module = (await import(/* @vite-ignore */ AUDIT_LOG_MODULE_NAME)) as {
      default: AuditLogPlugin;
    };
    const controller = module.default.create(options.config);
    console.log("Audit logs: using plugin implementation");
    return controller;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const message = error instanceof Error ? error.message : String(error);
    const isPluginMissing =
      (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
      (message.includes(`'${AUDIT_LOG_MODULE_NAME}'`) ||
        message.includes("'@triggerdotdev/plugins'"));

    if (options.requirePlugins) {
      throw new Error(
        `REQUIRE_PLUGINS=1 but plugin "${AUDIT_LOG_MODULE_NAME}" did not load: ${message}`,
        { cause: error }
      );
    }
    // A missing plugin is the normal self-hosted case, so only a broken one is logged.
    if (!isPluginMissing) {
      console.error("Audit logs: plugin found but failed to load; nothing is recorded", error);
    }
    return null;
  }
}
