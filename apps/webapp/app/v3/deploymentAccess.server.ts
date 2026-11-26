import type {
  DeploymentAccessCheck,
  DeploymentAccessController,
  DeploymentAccessDecision,
  DeploymentAccessPlugin,
  DeploymentIntegrationAccess,
  SlidingWindowHitResult,
} from "@trigger.dev/plugins";
import { Ratelimit } from "@upstash/ratelimit";
import { prisma, type PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { type RedisWithClusterOptions } from "~/redis.server";
import { logger } from "~/services/logger.server";
import { isCloud } from "~/services/platform.v3.server";
import { createRedisRateLimitClient, RateLimiter } from "~/services/rateLimiterCore.server";
import { singleton } from "~/utils/singleton";
import { syncComputeOnlyFlag } from "./computeOnlyFlag.server";
import { globalFlagsRegistry } from "./globalFlagsRegistry.server";
import { resolvePlanState } from "./freeSchedulePolicy.server";
import { ServiceValidationError } from "./services/common.server";

const MODULE_NAME = "@triggerdotdev/plugins/deployment-access";

const DEFAULT_DENIED_MESSAGE = "Deployments are not available for this organization.";
const FLAG_SYNC_FAILED_MESSAGE = "We couldn't prepare this deploy. Try deploying again.";

/** Null when no deployment access plugin is loaded: every check allows. */
export function getDeploymentAccessController(): Promise<DeploymentAccessController | null> {
  return singleton("deploymentAccessController", async () => {
    if (env.REQUIRE_PLUGINS !== "1" && !isCloud()) return null;
    return loadDeploymentAccessPlugin();
  });
}

async function loadDeploymentAccessPlugin(): Promise<DeploymentAccessController | null> {
  try {
    const module = (await import(/* @vite-ignore */ MODULE_NAME)) as {
      default: DeploymentAccessPlugin;
    };
    return module.default.create({
      // Small pools: the plugin only reads, a handful of primary-key lookups per check, and the
      // pools connect lazily, so a process that never runs a check opens no connection.
      database: {
        writerUrl: env.CONTROL_PLANE_DATABASE_URL ?? env.DATABASE_URL,
        readerUrl: env.CONTROL_PLANE_DATABASE_READ_REPLICA_URL ?? env.DATABASE_READ_REPLICA_URL,
        writerConnectionLimit: 1,
        readerConnectionLimit: 2,
      },
      billingStatus: resolvePlanState,
      slidingWindowHit,
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
      logger.error("Deployment access plugin found but failed to load", { error: message });
    }
    return null;
  }
}

type ControllerSource = { controller?: DeploymentAccessController | null };

async function resolveController({
  controller,
}: ControllerSource): Promise<DeploymentAccessController | null> {
  return controller === undefined ? getDeploymentAccessController() : controller;
}

/**
 * Asks the plugin whether a deploy may go ahead. Without a plugin everything is allowed. A plugin
 * that throws denies: a check that can't run must not open the door.
 *
 * The global `computeOnlyDeploys` flag goes with every check, read from the global flag snapshot
 * (reloaded every GLOBAL_FLAGS_RELOAD_INTERVAL_MS). A cold snapshot reads as off.
 *
 * Placement is decided once, at initialize: an allowed decision there is mirrored into the org's
 * `computeOnly` flag. Pass the org's loaded `featureFlags` as `organizationFeatureFlags` so the
 * write only happens when the flag changes. A flag that can't be written denies too, so a
 * compute-only org never deploys without it. A denied decision leaves the flag alone: an org
 * already on compute keeps running there. Preflight and register_worker never touch the flag.
 */
export async function checkDeployAccess(
  request: Omit<DeploymentAccessCheck, "computeOnlyDeploys">,
  {
    client = prisma,
    computeOnlyDeploys = globalFlagsRegistry.current()?.computeOnlyDeploys ?? false,
    organizationFeatureFlags,
    ...source
  }: ControllerSource & {
    client?: PrismaClientOrTransaction;
    computeOnlyDeploys?: boolean;
    organizationFeatureFlags?: unknown;
  } = {}
): Promise<DeploymentAccessDecision> {
  const check: DeploymentAccessCheck = { ...request, computeOnlyDeploys };
  try {
    const controller = await resolveController(source);
    if (!controller) return { allowed: true };
    const decision = await controller.checkDeploy(check);
    if (decision.allowed && check.stage === "initialize") {
      try {
        await syncComputeOnlyFlag(
          client,
          check.organizationId,
          decision,
          organizationFeatureFlags,
          {
            stage: check.stage,
            projectId: check.projectId,
            environmentId: check.environmentId,
          }
        );
      } catch (error) {
        // Still refused (a compute-only org must never deploy without its flag), but this is a
        // transient failure, so say to retry rather than that deploys aren't available.
        logger.error("Deployment access: couldn't update the computeOnly flag", {
          organizationId: check.organizationId,
          placement: decision.placement,
          error: error instanceof Error ? error.message : String(error),
        });
        return { allowed: false, kind: "denied", message: FLAG_SYNC_FAILED_MESSAGE };
      }
    }
    return decision;
  } catch (error) {
    logger.error("Deployment access check failed", {
      stage: check.stage,
      organizationId: check.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { allowed: false, kind: "denied" };
  }
}

export class DeploymentAccessError extends ServiceValidationError {
  constructor(message: string = DEFAULT_DENIED_MESSAGE) {
    super(message, 403, "warn");
    this.name = "DeploymentAccessError";
  }
}

export function deniedMessage(decision: Extract<DeploymentAccessDecision, { allowed: false }>) {
  return decision.message ?? DEFAULT_DENIED_MESSAGE;
}

/** Whether the organization may start a new connection to each integration. */
export async function integrationAccess(
  organizationId: string,
  source: ControllerSource = {}
): Promise<DeploymentIntegrationAccess> {
  try {
    const controller = await resolveController(source);
    if (!controller) return { github: true, vercel: true };
    return await controller.integrationAccess(organizationId);
  } catch (error) {
    logger.error("Integration access check failed", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { github: false, vercel: false };
  }
}

export async function canConnectIntegration(
  organizationId: string,
  integration: keyof DeploymentIntegrationAccess,
  source: ControllerSource = {}
): Promise<boolean> {
  return (await integrationAccess(organizationId, source))[integration];
}

/**
 * Which integration panels a project shows. An organization that can't start new connections
 * keeps the panel for a connection it already has, so it can still inspect and disconnect it.
 */
export async function resolveIntegrationAccess(
  organizationId: string,
  projectId: string,
  { client = prisma, ...source }: ControllerSource & { client?: PrismaClientOrTransaction } = {}
): Promise<DeploymentIntegrationAccess> {
  const access = await integrationAccess(organizationId, source);
  if (access.github && access.vercel) return access;

  const [githubRepository, vercelProject] = await Promise.all([
    access.github
      ? null
      : client.connectedGithubRepository.findFirst({
          where: {
            projectId,
            repository: { installation: { deletedAt: null, suspendedAt: null } },
          },
          select: { id: true },
        }),
    access.vercel
      ? null
      : client.organizationProjectIntegration.findFirst({
          where: {
            projectId,
            deletedAt: null,
            organizationIntegration: { service: "VERCEL", deletedAt: null },
          },
          select: { id: true },
        }),
  ]);

  return {
    github: access.github || githubRepository !== null,
    vercel: access.vercel || vercelProject !== null,
  };
}

// The sliding-window counter the plugin uses for per-organization limits. One Redis client and
// one limiter per (window, limit), shared across calls: a limiter per call would open its own
// connection.
let redisClient: ReturnType<typeof createRedisRateLimitClient> | undefined;
const limiters = new Map<string, RateLimiter>();

function rateLimitRedisOptions(): RedisWithClusterOptions {
  return {
    port: env.RATE_LIMIT_REDIS_PORT,
    host: env.RATE_LIMIT_REDIS_HOST,
    username: env.RATE_LIMIT_REDIS_USERNAME,
    password: env.RATE_LIMIT_REDIS_PASSWORD,
    tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
    clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
  };
}

function limiterFor(window: "1h" | "1d", limit: number): RateLimiter {
  const key = `${window}:${limit}`;
  let limiter = limiters.get(key);
  if (!limiter) {
    redisClient ??= createRedisRateLimitClient(rateLimitRedisOptions());
    limiter = new RateLimiter({
      redisClient,
      // The limit is part of the key, so changing it starts fresh windows.
      keyPrefix: `deploymentAccess:${window}:${limit}`,
      limiter: Ratelimit.slidingWindow(limit, window === "1h" ? "1 h" : "1 d"),
      // A Redis outage must not stall deploys: past this the library answers "allowed".
      timeoutMs: 1_000,
      // Every hit consults Redis. The library's local cache would keep a rejection until the end
      // of the fixed bucket, long after the sliding window has capacity again, and each webapp
      // process would answer differently.
      ephemeralCache: false,
      logFailure: false,
    });
    limiters.set(key, limiter);
  }
  return limiter;
}

async function slidingWindowHit({
  key,
  limit,
  window,
}: {
  key: string;
  limit: number;
  window: "1h" | "1d";
}): Promise<SlidingWindowHitResult> {
  try {
    // The hash tag keeps the current and previous bucket keys in one Redis Cluster slot; the
    // library reads both in a single script.
    const result = await limiterFor(window, limit).limit(`{${key}}`);
    // Past its timeout the library answers "allowed" with a limit of 0, which a real answer never
    // has: the limit is at least 1 here.
    if (result.limit === 0) return { status: "unavailable" };
    return {
      status: "counted",
      count: result.success ? result.limit - result.remaining : result.limit,
      limited: !result.success,
    };
  } catch (error) {
    logger.warn("Sliding window counter unavailable", {
      window,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "unavailable" };
  }
}
