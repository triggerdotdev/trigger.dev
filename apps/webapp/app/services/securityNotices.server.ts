import type {
  SecurityNoticeBanner,
  SecurityNoticeScope,
  SecurityNoticesController,
  SecurityNoticesPlugin,
} from "@trigger.dev/plugins";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { isCloud } from "~/services/platform.v3.server";
import { rbac } from "~/services/rbac.server";
import { singleton } from "~/utils/singleton";

const MODULE_NAME = "@triggerdotdev/plugins/security-notices";

/** Null when security notices are off: not Cloud, or no plugin. */
export function getSecurityNoticesController(): Promise<SecurityNoticesController | null> {
  return singleton("securityNoticesController", async () => {
    if (!isCloud()) return null;
    return loadSecurityNoticesPlugin();
  });
}

async function loadSecurityNoticesPlugin(): Promise<SecurityNoticesController | null> {
  try {
    const module = (await import(/* @vite-ignore */ MODULE_NAME)) as {
      default: SecurityNoticesPlugin;
    };
    return module.default.create({
      database: {
        writerUrl: env.CONTROL_PLANE_DATABASE_URL ?? env.DATABASE_URL,
        readerUrl: env.CONTROL_PLANE_DATABASE_READ_REPLICA_URL ?? env.DATABASE_READ_REPLICA_URL,
      },
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const message = error instanceof Error ? error.message : String(error);
    const isPluginMissing =
      (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
      (message.includes(`'${MODULE_NAME}'`) || message.includes("'@triggerdotdev/plugins'"));

    if (env.REQUIRE_PLUGINS === "1") {
      throw new Error(`REQUIRE_PLUGINS=1 but plugin "${MODULE_NAME}" did not load: ${message}`, {
        cause: error,
      });
    }
    if (!isPluginMissing) {
      logger.error("Security notices plugin found but failed to load", { error: message });
    }
    return null;
  }
}

/** Security notices are for the organization's Owners and Admins only. OSS-safe: no plugin, no role. */
export async function canSeeSecurityNotices(scope: SecurityNoticeScope): Promise<boolean> {
  const role = await rbac.getUserRole({
    userId: scope.userId,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
  });
  return !!role && role.isSystem && (role.name === "Owner" || role.name === "Admin");
}

/**
 * Never throws: a failed read hides the banner rather than breaking the page. The role is only
 * looked up when the project has a banner to show.
 */
export async function getSecurityNoticeBanner(
  scope: SecurityNoticeScope
): Promise<SecurityNoticeBanner | null> {
  try {
    const controller = await getSecurityNoticesController();
    const banner = (await controller?.getBanner(scope)) ?? null;
    if (!banner) return null;
    return (await canSeeSecurityNotices(scope)) ? banner : null;
  } catch (error) {
    logger.error("Failed to read the security notice banner", {
      ...scope,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
