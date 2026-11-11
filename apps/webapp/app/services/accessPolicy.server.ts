import type {
  AccessPolicyController,
  AccessPolicyPlugin,
  AdminActionInput,
  AdminActionResult,
  AdminPanel,
  OrganizationJoinCheck,
  SessionCheck,
  SessionDecision,
  SignInCheck,
} from "@trigger.dev/plugins";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";

const MODULE_NAME = "@triggerdotdev/plugins/access-policy";

/** Null when no access policy plugin is loaded: every check passes. */
function getAccessPolicyController(): Promise<AccessPolicyController | null> {
  return singleton("accessPolicyController", loadAccessPolicyPlugin);
}

async function loadAccessPolicyPlugin(): Promise<AccessPolicyController | null> {
  try {
    const module = (await import(/* @vite-ignore */ MODULE_NAME)) as {
      default: AccessPolicyPlugin;
    };
    return module.default.create({
      database: {
        writerUrl: env.CONTROL_PLANE_DATABASE_URL ?? env.DATABASE_URL,
        readerUrl: env.CONTROL_PLANE_DATABASE_READ_REPLICA_URL ?? env.DATABASE_READ_REPLICA_URL,
        writerConnectionLimit: 2,
        readerConnectionLimit: 3,
      },
      generateRootApiKeys: async (environmentType) => {
        const { createApiKeyForEnv, createPkApiKeyForEnv } =
          await import("~/models/api-key.server");
        return {
          apiKey: createApiKeyForEnv(environmentType as never),
          pkApiKey: createPkApiKeyForEnv(environmentType as never),
        };
      },
      // The run queue, bulk-cancel and billing modules load Redis-backed singletons; import lazily.
      cancelOrganizationRuns: async (organizationId, dedupeKey) => {
        const { BillingLimitBulkCancelService } =
          await import("~/v3/services/billingLimit/BillingLimitBulkCancelService.server");
        return BillingLimitBulkCancelService.cancelAllRunsForOrganization(organizationId, {
          dedupeKey,
        });
      },
      syncEnvironmentLimit: async (environmentId, limit) => {
        const { findEnvironmentById } = await import("~/models/runtimeEnvironment.server");
        const { updateEnvConcurrencyLimits } = await import("~/v3/runQueue.server");
        const environment = await findEnvironmentById(environmentId);
        if (environment) await updateEnvConcurrencyLimits(environment, limit);
      },
      invalidateCaches: async (organizationId, environmentIds) => {
        const { controlPlaneResolver } =
          await import("~/v3/runOpsMigration/controlPlaneResolver.server");
        controlPlaneResolver.invalidateOrganization(organizationId);
        for (const id of environmentIds) controlPlaneResolver.invalidateEnvironment(id);
      },
      billingPauseState: async (organizationId, environmentType) => {
        const { getBillingLimit, isBillingConfigured } =
          await import("~/services/platform.v3.server");
        const { getInitialEnvPauseStateForBillingLimit } =
          await import("~/v3/services/billingLimit/getInitialEnvPauseStateForBillingLimit.server");
        if (!isBillingConfigured()) return { paused: false, pauseSource: null };
        // getBillingLimit swallows failures into undefined, so undefined means it could not be read.
        const billingLimit = await getBillingLimit(organizationId).catch(() => undefined);
        if (billingLimit === undefined) return "unknown";
        return getInitialEnvPauseStateForBillingLimit(organizationId, environmentType as never, {
          getBillingLimit: async () => billingLimit,
        });
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
      logger.error("Access policy plugin found but failed to load", { error: message });
    }
    return null;
  }
}

type ControllerSource = { controller?: AccessPolicyController | null };

async function resolveController({ controller }: ControllerSource) {
  return controller === undefined ? getAccessPolicyController() : controller;
}

/** Without a plugin the host's own domain rules decide. A check that can't run refuses. */
export async function isSignInAllowed(check: SignInCheck, source: ControllerSource = {}) {
  try {
    const controller = await resolveController(source);
    if (!controller) return !check.domainBlocked;
    return (await controller.checkSignIn(check)).allowed;
  } catch (error) {
    logger.error("Sign-in check failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function checkSession(
  check: SessionCheck,
  source: ControllerSource = {}
): Promise<SessionDecision> {
  try {
    const controller = await resolveController(source);
    if (!controller) return { valid: true };
    return await controller.checkSession(check);
  } catch (error) {
    logger.error("Session check failed", {
      userId: check.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { valid: false };
  }
}

export async function isSessionValid(check: SessionCheck, source: ControllerSource = {}) {
  return (await checkSession(check, source)).valid;
}

export async function isOrganizationJoinAllowed(
  check: OrganizationJoinCheck,
  source: ControllerSource = {}
) {
  try {
    const controller = await resolveController(source);
    if (!controller) return true;
    return (await controller.checkOrganizationJoin(check)).allowed;
  } catch (error) {
    logger.error("Organization join check failed", {
      organizationId: check.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Organizations among `organizationIds` the plugin forces support access open for. Empty without a plugin or on error. */
export async function forcedSupportAccess(
  organizationIds: string[],
  source: ControllerSource = {}
): Promise<Set<string>> {
  if (organizationIds.length === 0) return new Set();
  try {
    const controller = await resolveController(source);
    if (!controller) return new Set();
    return new Set(await controller.forcedSupportAccess(organizationIds));
  } catch (error) {
    logger.error("Support access check failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Set();
  }
}

export async function getOrganizationAdminPanel(
  organizationId: string,
  source: ControllerSource = {}
): Promise<AdminPanel | null> {
  const controller = await resolveController(source);
  return controller ? controller.organizationAdminPanel(organizationId) : null;
}

export async function performOrganizationAdminAction(
  input: AdminActionInput,
  source: ControllerSource = {}
): Promise<AdminActionResult> {
  const controller = await resolveController(source);
  if (!controller) return { ok: false, errors: { intent: ["Unknown action."] } };
  return controller.performOrganizationAdminAction(input);
}
