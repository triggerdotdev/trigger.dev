import { getMeter, type Meter } from "@internal/tracing";
import { Logger, type LogLevel } from "@trigger.dev/core/logger";
import type {
  DeploymentCheckImage,
  DeploymentCheckOutcome,
  DeploymentChecksController,
  DeploymentChecksPlugin,
  DeploymentChecksPluginConfig,
} from "@trigger.dev/plugins";
import { Worker as RedisWorker } from "@trigger.dev/redis-worker";
import type { RedisOptions } from "ioredis";
import { z } from "zod";
import { prisma as defaultPrisma, type PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { isCloud } from "~/services/platform.v3.server";
import { singleton } from "~/utils/singleton";
import { resolvePlanState } from "~/v3/freeSchedulePolicy.server";
import { getRegistryConfig } from "~/v3/registryConfig.server";
import { readDeploymentCheckImage } from "~/v3/services/deploymentCheckImage.server";

const MODULE_NAME = "@triggerdotdev/plugins/deployment-checks";
const JOB = "deployments.check";
const MAX_ATTEMPTS = 5;
// A missing or unconfigured plugin is looked for again after this long.
const RELOAD_AFTER_MS = 5 * 60_000;

export const deploymentCheckJob = {
  schema: z.object({ deploymentId: z.string() }),
  visibilityTimeoutMs: 10 * 60_000,
  retry: {
    maxAttempts: MAX_ATTEMPTS,
    minTimeoutInMs: 30_000,
    maxTimeoutInMs: 10 * 60_000,
    factor: 2,
  },
};

export function deploymentCheckTelemetry(meter: Meter) {
  return {
    decisions: meter.createCounter("deployment_checks.decisions_total", {
      description: "Deployment check decisions by mode, selection and outcome",
    }),
    duration: meter.createHistogram("deployment_checks.duration_ms", {
      description: "Deployment check duration",
      unit: "ms",
    }),
    pluginMissing: meter.createCounter("deployment_checks.plugin_missing_total", {
      description: "Times the deployment checks plugin did not load on Cloud",
    }),
    noPlugin: meter.createCounter("deployment_checks.no_plugin_total", {
      description: "Queued deployment checks this worker could not run",
    }),
  };
}

type DeploymentCheckTelemetry = ReturnType<typeof deploymentCheckTelemetry>;

const defaultTelemetry = singleton("deploymentCheckTelemetry", () =>
  deploymentCheckTelemetry(getMeter("deployment-checks"))
);

/** What the plugin gets from the host. It reads its own settings with this database. */
function pluginConfig(): DeploymentChecksPluginConfig {
  return {
    // Small pools: one primary-key read per check, off the request path. They connect lazily, so
    // a process that never runs a check opens no connection.
    database: {
      writerUrl: env.CONTROL_PLANE_DATABASE_URL ?? env.DATABASE_URL,
      readerUrl: env.CONTROL_PLANE_DATABASE_READ_REPLICA_URL ?? env.DATABASE_READ_REPLICA_URL,
      writerConnectionLimit: 1,
      readerConnectionLimit: 1,
    },
    billingStatus: resolvePlanState,
  };
}

/**
 * Loads the plugin. Null when checks are off: not Cloud, no plugin, or the plugin isn't configured.
 * With REQUIRE_PLUGINS=1 a plugin that doesn't load throws, wherever the webapp runs.
 */
export async function loadDeploymentChecksController({
  requirePlugins,
  cloud,
  moduleName = MODULE_NAME,
  telemetry = defaultTelemetry,
  config = pluginConfig,
}: {
  requirePlugins: boolean;
  cloud: boolean;
  moduleName?: string;
  telemetry?: DeploymentCheckTelemetry;
  config?: () => DeploymentChecksPluginConfig;
}): Promise<DeploymentChecksController | null> {
  if (!deploymentChecksCanRun({ requirePlugins, cloud })) return null;

  let plugin: DeploymentChecksPlugin;
  try {
    plugin = ((await import(/* @vite-ignore */ moduleName)) as { default: DeploymentChecksPlugin })
      .default;
  } catch (error) {
    if (requirePlugins) {
      throw new Error(
        `REQUIRE_PLUGINS=1 but plugin "${moduleName}" did not load: ${errorMessage(error)}`,
        { cause: error }
      );
    }
    logger.warn("Deployment checks plugin did not load", { error: errorMessage(error) });
    telemetry.pluginMissing.add(1);
    return null;
  }
  return plugin.create(config());
}

type ControllerLoad = {
  promise: Promise<DeploymentChecksController | null>;
  at: number;
  /** Undefined while loading. */
  result?: DeploymentChecksController | null;
};

const controllerLoad = singleton("deploymentChecksControllerLoad", () => ({
  current: undefined as ControllerLoad | undefined,
}));

/**
 * The loaded controller. Callers share one load, so a process creates one controller and one set
 * of database pools. A null result is looked for again after a while; a failed load isn't kept.
 */
export function getDeploymentChecksController(): Promise<DeploymentChecksController | null> {
  const current = controllerLoad.current;
  if (current && (current.result !== null || Date.now() - current.at < RELOAD_AFTER_MS)) {
    return current.promise;
  }
  const load: ControllerLoad = {
    at: Date.now(),
    promise: loadDeploymentChecksController({
      requirePlugins: env.REQUIRE_PLUGINS === "1",
      cloud: isCloud(),
    }),
  };
  controllerLoad.current = load;
  load.promise.then(
    (controller) => {
      load.result = controller;
    },
    () => {
      if (controllerLoad.current === load) controllerLoad.current = undefined;
    }
  );
  return load.promise;
}

type DeploymentCheckQueue = {
  enqueueOnce(options: {
    id: string;
    job: typeof JOB;
    payload: { deploymentId: string };
  }): Promise<unknown>;
};

/** Whether deployment checks are enabled: on Cloud, or wherever plugins are required. */
function deploymentChecksCanRun({
  requirePlugins,
  cloud,
}: {
  requirePlugins: boolean;
  cloud: boolean;
}): boolean {
  return requirePlugins || cloud;
}

/**
 * Queues one check per deployment: the job id is stable. Queues a check wherever checks are
 * enabled. Never throws.
 */
export async function enqueueDeploymentCheck(
  queue: DeploymentCheckQueue,
  deploymentId: string,
  canRun: () => boolean = () =>
    deploymentChecksCanRun({ requirePlugins: env.REQUIRE_PLUGINS === "1", cloud: isCloud() })
): Promise<void> {
  try {
    if (!canRun()) return;
    await queue.enqueueOnce({
      id: `deploymentCheck:${deploymentId}`,
      job: JOB,
      payload: { deploymentId },
    });
  } catch (error) {
    logger.error("Failed to queue the deployment check", {
      deploymentId,
      error: errorMessage(error),
    });
  }
}

export function createDeploymentChecksWorker({
  redisOptions,
  concurrency,
  shutdownTimeoutMs,
  pollIntervalMs,
  logLevel = "info",
  dependencies,
}: {
  redisOptions: RedisOptions;
  concurrency: { workers: number; tasksPerWorker: number; limit: number };
  shutdownTimeoutMs: number;
  pollIntervalMs?: number;
  logLevel?: LogLevel;
  dependencies?: DeploymentCheckJobDependencies;
}) {
  return new RedisWorker({
    name: "deployment-checks-worker",
    redisOptions,
    catalog: { [JOB]: deploymentCheckJob },
    jobs: {
      [JOB]: async ({ payload, attempt }) => {
        await runDeploymentCheck({ deploymentId: payload.deploymentId, attempt }, dependencies);
      },
    },
    concurrency,
    shutdownTimeoutMs,
    pollIntervalMs,
    logger: new Logger("DeploymentChecksWorker", logLevel),
  });
}

/** Thrown to retry the job later. The worker logs it at warn, not error. */
class DeploymentCheckRetryError extends Error {
  readonly logLevel = "warn";
}

export type DeploymentCheckJobOutcome =
  | "no_plugin"
  | "not_found"
  | "skipped"
  | DeploymentCheckOutcome;

export type DeploymentCheckJobDependencies = {
  prisma?: PrismaClientOrTransaction;
  /** Null means no plugin. Loaded when left out. */
  controller?: DeploymentChecksController | null;
  telemetry?: DeploymentCheckTelemetry;
  /** Reads the image for the check; the registry by default. See `readDeploymentCheckImage`. */
  readImage?: (input: DeploymentCheckImageInput) => Promise<DeploymentCheckImage | null>;
};

type DeploymentCheckImageInput = {
  imageReference: string;
  imageDigest: string;
  projectRef: string;
  isV4Deployment: boolean;
};

let warnedHalfReadRole = false;

function readImageFromRegistry({
  imageReference,
  imageDigest,
  projectRef,
  isV4Deployment,
}: DeploymentCheckImageInput): Promise<DeploymentCheckImage | null> {
  const roleArn = env.DEPLOYMENT_CHECKS_ECR_ROLE_ARN;
  const externalId = env.DEPLOYMENT_CHECKS_ECR_ROLE_EXTERNAL_ID;
  if (!roleArn !== !externalId && !warnedHalfReadRole) {
    warnedHalfReadRole = true;
    logger.warn(
      "Deployment checks read role half configured: set both DEPLOYMENT_CHECKS_ECR_ROLE_ARN and DEPLOYMENT_CHECKS_ECR_ROLE_EXTERNAL_ID, or neither"
    );
  }
  return readDeploymentCheckImage({
    imageReference,
    imageDigest,
    projectRef,
    registryConfig: getRegistryConfig(isV4Deployment),
    readRole: roleArn && externalId ? { roleArn, externalId } : undefined,
  });
}

/**
 * Runs the check for one deployment. It reads the deployment and never writes it: the outcome goes
 * to a log line and a metric. An unavailable answer that may change throws, so the worker retries
 * later; the last attempt records it instead.
 */
export async function runDeploymentCheck(
  { deploymentId, attempt }: { deploymentId: string; attempt: number },
  {
    prisma = defaultPrisma,
    controller: injectedController,
    telemetry = defaultTelemetry,
    readImage = readImageFromRegistry,
  }: DeploymentCheckJobDependencies = {}
): Promise<DeploymentCheckJobOutcome> {
  const controller =
    injectedController === undefined ? await getDeploymentChecksController() : injectedController;
  if (!controller) {
    // A queued check this worker cannot run is counted.
    telemetry.noPlugin.add(1);
    return "no_plugin";
  }

  const deployment = await prisma.workerDeployment.findFirst({
    where: { id: deploymentId },
    select: {
      id: true,
      friendlyId: true,
      imageReference: true,
      type: true,
      project: { select: { externalRef: true, organizationId: true } },
    },
  });
  if (!deployment) {
    logger.warn("Deployment check skipped: deployment not found", { deploymentId });
    return "not_found";
  }

  const organizationId = deployment.project.organizationId;
  const decision = await controller.decide({ organizationId, deploymentId: deployment.id });
  const log = {
    deploymentId: deployment.id,
    deploymentFriendlyId: deployment.friendlyId,
    organizationId,
    projectRef: deployment.project.externalRef,
    mode: decision.plan,
    selectedBy: decision.selectedBy,
  };
  const finish = (
    outcome: DeploymentCheckJobOutcome,
    details: Record<string, unknown> = {}
  ): DeploymentCheckJobOutcome => {
    telemetry.decisions.add(1, {
      mode: decision.plan,
      selected_by: decision.selectedBy,
      outcome,
    });
    const line = { ...log, outcome, attempt, ...details };
    // Log a deployment that was selected for a check but could not be checked.
    const selectedButSkipped = outcome === "skipped" && decision.plan !== "skip";
    if (outcome === "unavailable" || selectedButSkipped)
      logger.warn("deploymentChecks.result", line);
    else if (outcome === "skipped") logger.debug("deploymentChecks.result", line);
    else logger.info("deploymentChecks.result", line);
    return outcome;
  };

  if (decision.plan === "skip") return finish("skipped");

  const imageDigest = deployment.imageReference?.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
  if (!deployment.imageReference || !imageDigest) return finish("skipped");

  // Read fresh on every attempt: the download URLs are short-lived. Without it the check has to
  // get the image another way, as it did before the host supplied it.
  const image = await readImage({
    imageReference: deployment.imageReference,
    imageDigest,
    projectRef: deployment.project.externalRef,
    isV4Deployment: deployment.type === "MANAGED",
  });
  // Timed from here, so the duration stays the check's own and not the image read's.
  const startedAt = performance.now();
  const result = await controller.check({
    organizationId,
    projectRef: deployment.project.externalRef,
    deploymentId: deployment.id,
    imageDigest,
    ...(image ? { image } : {}),
    decision: { plan: decision.plan, selectedBy: decision.selectedBy },
  });
  const durationMs = Math.round(performance.now() - startedAt);
  telemetry.duration.record(durationMs, { mode: decision.plan, outcome: result.outcome });

  const lastAttempt = attempt >= MAX_ATTEMPTS - 1;
  if (result.outcome === "unavailable" && result.retryable && !lastAttempt) {
    logger.info("Deployment check unavailable, retrying later", {
      ...log,
      checkId: result.id,
      attempt,
      durationMs,
    });
    throw new DeploymentCheckRetryError("Deployment check unavailable, retrying later");
  }

  return finish(result.outcome, { checkId: result.id, durationMs });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
