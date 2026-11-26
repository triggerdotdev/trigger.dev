import { getMeter, type Meter } from "@internal/tracing";
import { Logger, type LogLevel } from "@trigger.dev/core/logger";
import type {
  DeploymentAccessBillingStatus,
  DeploymentCheckDecision,
  DeploymentCheckOutcome,
  DeploymentCheckResult,
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
import {
  lookupDeploymentCheckTag,
  readDeploymentCheckImage,
  type DeploymentCheckImageRead,
  type DeploymentCheckNotRead,
  type DeploymentCheckTagLookup,
} from "~/v3/services/deploymentCheckImage.server";
import {
  resolveEcrImageDigest,
  type ResolvedImage,
} from "~/v3/services/verifyDeploymentImage.server";

const MODULE_NAME = "@triggerdotdev/plugins/deployment-checks";
const JOB = "deployments.check";
const MAX_ATTEMPTS = 5;
// A missing or unconfigured plugin is looked for again after this long.
const RELOAD_AFTER_MS = 5 * 60_000;
// Window in which a check with a retryable no-answer, or an image read worth retrying, is tried
// once more.
const GATE_RECHECK_WITHIN_MS = 60_000;
// Histogram buckets for check durations.
const DURATION_BUCKETS_MS = [
  250, 500, 1_000, 2_500, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000, 180_000, 240_000, 300_000,
  360_000, 420_000,
];

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
      advice: { explicitBucketBoundaries: DURATION_BUCKETS_MS },
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
    // Small pools: one primary-key read per decision. They connect lazily, so a process that never
    // decides opens no connection.
    database: {
      writerUrl: env.CONTROL_PLANE_DATABASE_URL ?? env.DATABASE_URL,
      readerUrl: env.CONTROL_PLANE_DATABASE_READ_REPLICA_URL ?? env.DATABASE_READ_REPLICA_URL,
      writerConnectionLimit: 1,
      readerConnectionLimit: 1,
    },
    billingStatus: billingStatusForChecks,
  };
}

/** The org's billing status; unknown on Cloud when billing isn't configured. */
async function billingStatusForChecks(
  organizationId: string
): Promise<DeploymentAccessBillingStatus> {
  const status = await resolvePlanState(organizationId);
  return status === "not_configured" && isCloud() ? "unknown" : status;
}

/**
 * Loads the plugin. Null when checks are off here: not Cloud, or no plugin. With
 * REQUIRE_PLUGINS=1 a plugin that doesn't load throws, wherever the webapp runs.
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
  readImage?: (input: DeploymentCheckImageInput) => Promise<DeploymentCheckImageRead>;
  /** What the deployment's tag points to; the registry by default. See `lookupDeploymentCheckTag`. */
  lookupTag?: (input: DeploymentCheckTagInput) => Promise<DeploymentCheckTagLookup>;
};

type DeploymentCheckTagInput = {
  imageReference: string;
  projectRef: string;
  isV4Deployment: boolean;
};

type DeploymentCheckImageInput = DeploymentCheckTagInput & { imageDigest: string };

let warnedHalfReadRole = false;

/** Where the registry reads go, as the deployment checks read role. */
function registryTarget({ imageReference, projectRef, isV4Deployment }: DeploymentCheckTagInput) {
  const roleArn = env.DEPLOYMENT_CHECKS_ECR_ROLE_ARN;
  const externalId = env.DEPLOYMENT_CHECKS_ECR_ROLE_EXTERNAL_ID;
  if (!roleArn !== !externalId && !warnedHalfReadRole) {
    warnedHalfReadRole = true;
    logger.warn(
      "Deployment checks read role half configured: set both DEPLOYMENT_CHECKS_ECR_ROLE_ARN and DEPLOYMENT_CHECKS_ECR_ROLE_EXTERNAL_ID, or neither"
    );
  }
  return {
    imageReference,
    projectRef,
    registryConfig: getRegistryConfig(isV4Deployment),
    readRole: roleArn && externalId ? { roleArn, externalId } : undefined,
  };
}

function readImageFromRegistry(
  input: DeploymentCheckImageInput
): Promise<DeploymentCheckImageRead> {
  return readDeploymentCheckImage({ ...registryTarget(input), imageDigest: input.imageDigest });
}

function lookupTagInRegistry(input: DeploymentCheckTagInput): Promise<DeploymentCheckTagLookup> {
  return lookupDeploymentCheckTag(registryTarget(input));
}

/**
 * Runs the check for one deployment: it compares the stored digest with what the tag points to,
 * then checks the image. It reads the deployment and never writes it: the outcome goes to a log
 * line and a metric. An unavailable answer that may change, a lookup or image read worth
 * retrying, or a failed decision, throws, so the worker retries later; the last attempt records it
 * instead.
 */
export async function runDeploymentCheck(
  { deploymentId, attempt }: { deploymentId: string; attempt: number },
  {
    prisma = defaultPrisma,
    controller: injectedController,
    telemetry = defaultTelemetry,
    readImage = readImageFromRegistry,
    lookupTag = lookupTagInRegistry,
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
  let decision: DeploymentCheckDecision;
  try {
    decision = validDecision(
      await controller.decide({ organizationId, deploymentId: deployment.id })
    );
  } catch (error) {
    // Retried like any other error; the last attempt records it.
    if (attempt < MAX_ATTEMPTS - 1) throw error;
    telemetry.decisions.add(1, {
      mode: "skip",
      selected_by: "decision_failed",
      outcome: "skipped",
      stage: "job",
    });
    logger.error("deploymentChecks.result", {
      deploymentId: deployment.id,
      deploymentFriendlyId: deployment.friendlyId,
      organizationId,
      projectRef: deployment.project.externalRef,
      mode: "skip",
      selectedBy: "decision_failed",
      outcome: "skipped",
      stage: "job",
      attempt,
      error: errorMessage(error),
    });
    return "skipped";
  }
  const log = {
    deploymentId: deployment.id,
    deploymentFriendlyId: deployment.friendlyId,
    organizationId,
    projectRef: deployment.project.externalRef,
    mode: decision.plan,
    selectedBy: decision.selectedBy,
    stage: "job",
  };
  const finish = (
    outcome: DeploymentCheckJobOutcome,
    details: Record<string, unknown> = {}
  ): DeploymentCheckJobOutcome => {
    telemetry.decisions.add(1, {
      mode: decision.plan,
      selected_by: decision.selectedBy,
      outcome,
      stage: "job",
    });
    const line = { ...log, outcome, attempt, ...details };
    // Log a deployment that was selected for a check but could not be checked.
    const selectedButSkipped = outcome === "skipped" && decision.plan !== "skip";
    if (outcome === "unavailable" || outcome === "fail" || selectedButSkipped)
      logger.warn("deploymentChecks.result", line);
    else if (outcome === "skipped") logger.debug("deploymentChecks.result", line);
    else logger.info("deploymentChecks.result", line);
    return outcome;
  };

  if (decision.plan === "skip") return finish("skipped");
  if (!deployment.imageReference) return finish("skipped");
  // Taken here, where the plan is known not to be skip; the checks below run in callbacks.
  const checkDecision = { plan: decision.plan, selectedBy: decision.selectedBy };

  const imageReference = deployment.imageReference;
  const target = {
    imageReference,
    projectRef: deployment.project.externalRef,
    isV4Deployment: deployment.type === "MANAGED",
  };
  const lastAttempt = attempt >= MAX_ATTEMPTS - 1;
  // Another host or a later try may manage, so only an answer that can never change is final.
  const retryLater = (notRead: ImageNotRead, what: string, fields: Record<string, unknown>) => {
    if (notRead.kind === "unreadable" || lastAttempt) return;
    logger.info(`Deployment check ${what} not read, retrying later`, {
      ...log,
      attempt,
      ...fields,
      kind: notRead.kind,
      detail: notRead.reason,
    });
    throw new DeploymentCheckRetryError(`Deployment check ${what} not read, retrying later`);
  };

  // The digest finalize stored: outside the gate, the one the client reported. Depending on where
  // they run, a deployment's runs use it or what the tag points to, so the tag is looked up first:
  // a stored digest that isn't the tag's is a mismatch however either image reads.
  const storedDigest = imageReference.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
  const tag = await lookupTag(target);
  if (tag.kind === "found" && storedDigest !== undefined && storedDigest !== tag.digest) {
    // Final at once, whatever the images hold. Both are still checked once, side by side and with
    // no retries, so the result line says what each held when it could be read. An error on either
    // side is noted in its entry, so the fail is always recorded.
    const checks = await Promise.all(
      [storedDigest, tag.digest].map(async (digest) => {
        try {
          const image = await readImage({ ...target, imageDigest: digest });
          if (image.kind !== "read") {
            return { imageDigest: digest, read: image.kind, detail: image.reason };
          }
          const checked = await controller.check({
            organizationId,
            projectRef: target.projectRef,
            deploymentId: deployment.id,
            imageDigest: digest,
            image: image.image,
            decision: checkDecision,
          });
          return { imageDigest: digest, checkId: checked.id, outcome: checked.outcome };
        } catch (error) {
          return { imageDigest: digest, error: errorMessage(error) };
        }
      })
    );
    return finish("fail", {
      reason: "digest_mismatch",
      imageDigest: tag.digest,
      reportedDigest: storedDigest,
      checks,
    });
  }

  // The stored digest when there is one, checked at once even when the lookup didn't answer (as
  // before the lookup existed), or else the tag's. With neither there is nothing to check yet.
  let imageDigest: string;
  if (tag.kind === "found") {
    imageDigest = storedDigest ?? tag.digest;
  } else if (storedDigest !== undefined) {
    imageDigest = storedDigest;
  } else {
    retryLater(tag, "image tag", {});
    const [outcome, details] = imageNotRead(tag);
    return finish(outcome, { ...details, step: "tag" });
  }
  const lookupDetails =
    tag.kind === "found" ? {} : { tagLookup: { kind: tag.kind, detail: tag.reason } };

  // Read fresh on every attempt: the download URLs are short-lived. A check is only asked for with
  // the image.
  const read = await readImage({ ...target, imageDigest });
  if (read.kind !== "read") {
    retryLater(read, "image", { imageDigest });
    const [outcome, details] = imageNotRead(read);
    return finish(outcome, { ...details, ...lookupDetails });
  }
  // Timed from here, so the duration stays the check's own and not the image read's.
  const startedAt = performance.now();
  const result = await controller.check({
    organizationId,
    projectRef: deployment.project.externalRef,
    deploymentId: deployment.id,
    imageDigest,
    image: read.image,
    decision: checkDecision,
  });
  const durationMs = Math.round(performance.now() - startedAt);
  telemetry.duration.record(durationMs, { mode: decision.plan, outcome: result.outcome });

  if (result.outcome === "unavailable" && result.retryable && !lastAttempt) {
    logger.info("Deployment check unavailable, retrying later", {
      ...log,
      checkId: result.id,
      attempt,
      durationMs,
    });
    throw new DeploymentCheckRetryError("Deployment check unavailable, retrying later");
  }

  if (tag.kind !== "found") {
    // The stored image was checked, but what the tag points to never was. Any answer but a pass
    // is final and stands at once, so a scan that already answered is never asked for again. A
    // pass waits for the lookup, tried again on a later attempt; on the last one the lookup's
    // answer stands, so the monitors for checks without an answer see it.
    if (result.outcome !== "pass") {
      return finish(result.outcome, { checkId: result.id, durationMs, ...lookupDetails });
    }
    const checked = { checkId: result.id, checkOutcome: result.outcome };
    retryLater(tag, "image tag", checked);
    const [outcome, details] = imageNotRead(tag);
    return finish(outcome, { ...details, step: "tag", ...checked, durationMs });
  }
  return finish(result.outcome, { checkId: result.id, durationMs });
}

type ImageNotRead = DeploymentCheckNotRead;

const IMAGE_NOT_READ_REASONS: Record<ImageNotRead["kind"], string> = {
  retry: "image_not_read",
  unreadable: "image_unreadable",
  not_configured: "image_read_not_configured",
};

/**
 * What an image that wasn't read counts as. One that can never be read (not a single image, over
 * the caps, not the project's own) fails, like an image the checker can't read. One that a later
 * read or another host may manage has no answer.
 */
function imageNotRead(read: ImageNotRead): ["fail" | "unavailable", Record<string, unknown>] {
  return [
    read.kind === "unreadable" ? "fail" : "unavailable",
    { reason: IMAGE_NOT_READ_REASONS[read.kind], detail: read.reason },
  ];
}

/** What a deploy the check refused says. The reason stays in the logs. */
export function deploymentRefusedMessage(deploymentFriendlyId: string): string {
  return `This deployment could not be completed. If you think this is a mistake, contact support and provide the ID: ${deploymentFriendlyId}.`;
}

/** What a deploy says when its check had no answer. */
export const DEPLOYMENT_CHECK_UNAVAILABLE_MESSAGE =
  "This deployment could not be completed right now. Please deploy again in a few minutes.";

/** The error a refused deploy is failed with. */
const REFUSED_ERROR_NAME = "DeploymentFailed";

export type DeploymentGateResult =
  /** The deploy goes on. */
  | { kind: "proceed"; checked: false }
  /** The deploy goes on with the resolved digest. */
  | { kind: "proceed"; checked: true; imageDigest: string }
  | { kind: "refuse"; error: { name: string; message: string } };

export type DeploymentGateDependencies = {
  /** Null means no plugin. Loaded when left out. */
  controller?: DeploymentChecksController | null;
  canRun?: () => boolean;
  /** What the deployment's tag points to. The registry by default. */
  resolveImage?: (input: {
    imageReference: string;
    isV4Deployment: boolean;
  }) => Promise<ResolvedImage>;
  readImage?: (input: DeploymentCheckImageInput) => Promise<DeploymentCheckImageRead>;
  /** Moves the deployment's DEPLOYING timeout out once. */
  extendTimeout?: (deploymentId: string) => Promise<void>;
  telemetry?: DeploymentCheckTelemetry;
};

/** Manifest types accepted for a deploy checked at finalize. */
const ACCEPTED_MANIFEST_TYPES: ReadonlySet<string> = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);

function resolveImageFromRegistry({
  imageReference,
  isV4Deployment,
}: {
  imageReference: string;
  isV4Deployment: boolean;
}): Promise<ResolvedImage> {
  return resolveEcrImageDigest({
    imageReference,
    registryConfig: getRegistryConfig(isV4Deployment),
  });
}

async function extendDeployingTimeout(deploymentId: string): Promise<void> {
  const { TimeoutDeploymentService } = await import("./services/timeoutDeployment.server");
  await TimeoutDeploymentService.enqueue(
    deploymentId,
    "DEPLOYING",
    "Indexing timed out",
    new Date(Date.now() + env.DEPLOY_TIMEOUT_MS)
  );
}

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

/** Decisions made without the org's settings. */
const UNREADABLE_SETTINGS: ReadonlySet<string> = new Set(["settings_unavailable", "org_not_found"]);

/**
 * The finalize-time step. Says whether the deploy goes on, and with which image digest. Never
 * throws. A refusal carries a generic message; the reason stays in the logs.
 */
export async function gateDeployment(
  deployment: {
    id: string;
    friendlyId: string;
    imageReference: string | null;
    type: string | null;
    organizationId: string;
    projectRef: string;
  },
  clientImageDigest: string | undefined,
  {
    controller: injectedController,
    canRun = () =>
      deploymentChecksCanRun({ requirePlugins: env.REQUIRE_PLUGINS === "1", cloud: isCloud() }),
    resolveImage = resolveImageFromRegistry,
    readImage = readImageFromRegistry,
    extendTimeout = extendDeployingTimeout,
    telemetry = defaultTelemetry,
  }: DeploymentGateDependencies = {}
): Promise<DeploymentGateResult> {
  if (!canRun()) return { kind: "proceed", checked: false };

  let controller: DeploymentChecksController | null;
  try {
    controller =
      injectedController === undefined ? await getDeploymentChecksController() : injectedController;
  } catch (error) {
    logger.error("deploymentChecks.gatePluginFailed", {
      deploymentId: deployment.id,
      error: errorMessage(error),
    });
    controller = null;
  }
  if (!controller) {
    telemetry.pluginMissing.add(1);
    logger.error("deploymentChecks.gateNoPlugin", { deploymentId: deployment.id });
    return { kind: "proceed", checked: false };
  }
  const checks = controller;

  const log = {
    deploymentId: deployment.id,
    deploymentFriendlyId: deployment.friendlyId,
    organizationId: deployment.organizationId,
    projectRef: deployment.projectRef,
    stage: "finalize",
  };
  // Asks the user to deploy again when retrying may help.
  const refusal = (deployAgain: boolean): DeploymentGateResult => ({
    kind: "refuse",
    error: {
      name: REFUSED_ERROR_NAME,
      message: deployAgain
        ? DEPLOYMENT_CHECK_UNAVAILABLE_MESSAGE
        : deploymentRefusedMessage(deployment.friendlyId),
    },
  });

  let decision: DeploymentCheckDecision;
  try {
    decision = validDecision(
      await checks.decide({
        organizationId: deployment.organizationId,
        deploymentId: deployment.id,
      })
    );
  } catch (error) {
    // Recorded, and the deploy goes on: every deploy needs a decision, so refusing would stop them
    // all.
    telemetry.decisions.add(1, {
      mode: "skip",
      selected_by: "decision_failed",
      outcome: "skipped",
      stage: "finalize",
    });
    logger.error("deploymentChecks.result", {
      ...log,
      mode: "skip",
      selectedBy: "decision_failed",
      outcome: "skipped",
      error: errorMessage(error),
    });
    return { kind: "proceed", checked: false };
  }

  if (decision.plan !== "gate") {
    if (UNREADABLE_SETTINGS.has(decision.selectedBy)) {
      // Counted at finalize, like the job counts it.
      telemetry.decisions.add(1, {
        mode: decision.plan,
        selected_by: decision.selectedBy,
        outcome: "skipped",
        stage: "finalize",
      });
      logger.warn("deploymentChecks.result", {
        ...log,
        mode: decision.plan,
        selectedBy: decision.selectedBy,
        outcome: "skipped",
      });
    }
    return { kind: "proceed", checked: false };
  }

  const gateLog = { ...log, mode: decision.plan, selectedBy: decision.selectedBy };
  const refuse = (
    outcome: "fail" | "unavailable",
    deployAgain: boolean,
    details: Record<string, unknown>
  ): DeploymentGateResult => {
    telemetry.decisions.add(1, {
      mode: "gate",
      selected_by: decision.selectedBy,
      outcome,
      stage: "finalize",
    });
    logger.warn("deploymentChecks.result", { ...gateLog, outcome, ...details });
    return refusal(outcome === "unavailable" && deployAgain);
  };

  // Once, so the finalize steps fit in the DEPLOYING timeout.
  try {
    await extendTimeout(deployment.id);
  } catch (error) {
    logger.warn("deploymentChecks.gateTimeoutNotExtended", {
      ...gateLog,
      error: errorMessage(error),
    });
  }

  try {
    if (!deployment.imageReference) {
      return refuse("unavailable", false, { reason: "no_image_reference" });
    }
    const imageReference = deployment.imageReference;
    const isV4Deployment = deployment.type === "MANAGED";
    const resolved = await resolveImage({ imageReference, isV4Deployment });
    if (resolved.kind !== "found") {
      return refuse("unavailable", true, { reason: `image_${resolved.kind}` });
    }
    if (!ACCEPTED_MANIFEST_TYPES.has(resolved.mediaType ?? "")) {
      return refuse("fail", false, { reason: "not_a_single_image", mediaType: resolved.mediaType });
    }
    // A malformed reported digest is ignored.
    const reported = clientImageDigest?.trim() || undefined;
    if (reported !== undefined && SHA256_DIGEST.test(reported) && reported !== resolved.digest) {
      return refuse("fail", false, {
        reason: "digest_mismatch",
        imageDigest: resolved.digest,
        reportedDigest: reported.slice(0, 80),
      });
    }

    // A check is only asked for with the image. Read fresh for every check: the download URLs are
    // short-lived.
    const check = async (): Promise<DeploymentCheckResult | ImageNotRead> => {
      const read = await readImage({
        imageReference,
        imageDigest: resolved.digest,
        projectRef: deployment.projectRef,
        isV4Deployment,
      });
      if (read.kind !== "read") return read;
      return checks.check({
        organizationId: deployment.organizationId,
        projectRef: deployment.projectRef,
        deploymentId: deployment.id,
        imageDigest: resolved.digest,
        image: read.image,
        decision: { plan: "gate", selectedBy: decision.selectedBy },
      });
    };
    const worthAnotherTry = (answer: DeploymentCheckResult | ImageNotRead) =>
      "outcome" in answer
        ? answer.outcome === "unavailable" && answer.retryable
        : answer.kind === "retry";

    const startedAt = performance.now();
    let answer = await check();
    // A check that ran before a second read failed, kept for the log line.
    let earlierCheckId: string | undefined;
    if (worthAnotherTry(answer) && performance.now() - startedAt < GATE_RECHECK_WITHIN_MS) {
      logger.info("deploymentChecks.gateRecheck", {
        ...gateLog,
        ...("outcome" in answer
          ? { checkId: answer.id }
          : { reason: IMAGE_NOT_READ_REASONS[answer.kind], detail: answer.reason }),
      });
      if ("outcome" in answer) earlierCheckId = answer.id;
      answer = await check();
    }
    const durationMs = Math.round(performance.now() - startedAt);
    // The last answer is an image read, not a check, so no check duration is recorded.
    if (!("outcome" in answer)) {
      const [outcome, details] = imageNotRead(answer);
      return refuse(outcome, answer.kind !== "unreadable", {
        ...details,
        durationMs,
        ...(earlierCheckId ? { checkId: earlierCheckId } : {}),
      });
    }
    const result = answer;
    telemetry.duration.record(durationMs, { mode: "gate", outcome: result.outcome });

    if (result.outcome === "pass" || result.outcome === "flagged") {
      telemetry.decisions.add(1, {
        mode: "gate",
        selected_by: decision.selectedBy,
        outcome: result.outcome,
        stage: "finalize",
      });
      logger.info("deploymentChecks.result", {
        ...gateLog,
        outcome: result.outcome,
        checkId: result.id,
        durationMs,
      });
      return { kind: "proceed", checked: true, imageDigest: resolved.digest };
    }
    // The message depends on whether retrying may help.
    return refuse(result.outcome, result.retryable, { checkId: result.id, durationMs });
  } catch (error) {
    return refuse("unavailable", true, { reason: "error", error: errorMessage(error) });
  }
}

const PLANS: ReadonlySet<string> = new Set(["gate", "shadow", "skip"]);

/** The plugin's decision. Throws for one this host can't act on. */
function validDecision(decision: DeploymentCheckDecision | undefined): DeploymentCheckDecision {
  if (!decision || !PLANS.has(decision.plan) || typeof decision.selectedBy !== "string")
    throw new Error("Invalid deployment check decision");
  return decision;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
