import type {
  ExternalOidcController,
  ExternalOidcPlugin,
  ExternalOidcPluginConfig,
} from "@trigger.dev/plugins";

const MODULE_NAME = "@triggerdotdev/plugins/oidc";

/** Null means external OIDC is off. There is never a host signing fallback. */
export async function loadExternalOidcPlugin(
  config: ExternalOidcPluginConfig,
  options: { requirePlugins: boolean }
): Promise<ExternalOidcController | null> {
  try {
    const module = (await import(/* @vite-ignore */ MODULE_NAME)) as {
      default: ExternalOidcPlugin;
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
      console.error("OIDC: plugin found but failed to load; external OIDC is unavailable", error);
    }
    return null;
  }
}
