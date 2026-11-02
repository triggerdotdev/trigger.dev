import { getMeter } from "@internal/tracing";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import type {
  ExternalOidcController,
  ExternalOidcEnvironment,
  ExternalOidcRunIdentity,
} from "@trigger.dev/plugins";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { isCloud } from "~/services/platform.v3.server";
import { createRedisRateLimitClient } from "~/services/rateLimiterCore.server";
import { singleton } from "~/utils/singleton";
import { globalFlagsRegistry } from "~/v3/globalFlagsRegistry.server";
import { runStore } from "~/v3/runStore.server";
import { resolveExternalOidcFlags } from "./externalOidcFeatureFlags";
import { loadExternalOidcPlugin } from "./externalOidcPlugin.server";
import { ExternalOidcRateLimits } from "./externalOidcRateLimit.server";
import { externalOidcSigningService } from "./instance.server";
import { runTokenInjectionEnabled } from "./runToken.server";

/** Null when external OIDC is off: not Cloud, no issuer, or no plugin. */
export function getExternalOidcController(): Promise<ExternalOidcController | null> {
  return singleton("externalOidcController", async () => {
    const issuer = env.OIDC_ISSUER_URL;
    if (!isCloud() || !issuer) return null;
    return loadExternalOidcPlugin(
      {
        issuer,
        signJwt: (payload, options) => externalOidcSigningService.signJwt(payload, options),
        findEnvironment,
        findExecutingRun,
      },
      { requirePlugins: env.REQUIRE_PLUGINS === "1" }
    );
  });
}

/** Whether to show OIDC setup. Minting also needs run tokens, so both must be on. */
export async function isExternalOidcEnabled(orgFeatureFlags: unknown): Promise<boolean> {
  if (!runTokenInjectionEnabled(orgFeatureFlags)) return false;
  const controller = await getExternalOidcController();
  return (
    controller?.isEnabled(
      resolveExternalOidcFlags(globalFlagsRegistry.current() ?? {}, orgFeatureFlags)
    ) ?? false
  );
}

async function findEnvironment(
  run: ExternalOidcRunIdentity
): Promise<ExternalOidcEnvironment | null> {
  const environment = await $replica.runtimeEnvironment.findFirst({
    where: {
      id: run.environmentId,
      organizationId: run.organizationId,
      projectId: run.projectId,
      archivedAt: null,
      project: { deletedAt: null },
      organization: { deletedAt: null },
    },
    select: {
      id: true,
      slug: true,
      type: true,
      organizationId: true,
      projectId: true,
      project: { select: { externalRef: true } },
      organization: { select: { featureFlags: true } },
    },
  });
  if (!environment) return null;
  return {
    id: environment.id,
    slug: environment.slug,
    type: environment.type,
    organizationId: environment.organizationId,
    projectId: environment.projectId,
    projectRef: environment.project.externalRef,
    orgFeatureFlags: resolveExternalOidcFlags(
      globalFlagsRegistry.current() ?? {},
      environment.organization.featureFlags
    ),
  };
}

async function findExecutingRun(run: ExternalOidcRunIdentity): Promise<{ taskId: string } | null> {
  let id: string;
  try {
    id = RunId.fromFriendlyId(run.runId);
  } catch {
    return null;
  }
  const found = await runStore.findRun(
    { id, runtimeEnvironmentId: run.environmentId, projectId: run.projectId },
    { select: { friendlyId: true, taskIdentifier: true, status: true, attemptNumber: true } }
  );
  if (
    !found ||
    found.friendlyId !== run.runId ||
    found.status !== "EXECUTING" ||
    found.attemptNumber !== run.attempt
  ) {
    return null;
  }
  return { taskId: found.taskIdentifier };
}

const RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS = 1_000;

export function getExternalOidcRateLimits(): ExternalOidcRateLimits {
  return singleton(
    "externalOidcRateLimits",
    () =>
      new ExternalOidcRateLimits(
        createRedisRateLimitClient({
          port: env.RATE_LIMIT_REDIS_PORT,
          host: env.RATE_LIMIT_REDIS_HOST,
          username: env.RATE_LIMIT_REDIS_USERNAME,
          password: env.RATE_LIMIT_REDIS_PASSWORD,
          tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
          clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
          maxRetriesPerRequest: 1,
          commandTimeout: RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS,
        })
      )
  );
}

export const externalOidcOutcomes = singleton("externalOidcOutcomes", () =>
  getMeter("external-oidc").createCounter("external_oidc.token.requests", {
    description: "External OIDC token requests by outcome",
  })
);
