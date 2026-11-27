import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { getMeter, type Meter } from "@internal/tracing";
import { machineNameOf, RetryOptions, type MachinePresetName } from "@trigger.dev/core/v3";
import type { Prisma, RuntimeEnvironmentType } from "@trigger.dev/database";
import { prisma as defaultPrisma, type PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { isOrgMigrated } from "~/runEngine/concerns/computeMigration.server";
import { logger } from "~/services/logger.server";
import type { TaskMetadataCache } from "~/services/taskMetadataCache.server";
import { taskMetadataCacheInstance } from "~/services/taskMetadataCacheInstance.server";
import { defaultMachine, getEntitlement } from "~/services/platform.v3.server";
import { singleton } from "~/utils/singleton";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";
import { globalFlagsRegistry } from "~/v3/globalFlagsRegistry.server";
import { machinePresetFromConfig, machinePresetFromName } from "~/v3/machinePresets.server";
import { resolveComputeAccess } from "~/v3/regionAccess.server";
import { WorkerGroupService } from "~/v3/services/worker/workerGroupService.server";
import {
  backingForQueue,
  selfBackingWorkerGroups,
  workerRegionRegistry,
} from "~/v3/workerRegions.server";

/** A named machine's image, which gets its own template. */
export type MachineImage = { machineId: string; imageReference: string };

// wait: hold finalisation until the builder replies or times out. shadow: fire and
// forget. Neither ever fails the deploy.
export type TemplatePrebuildMode = "wait" | "shadow" | "skip";

export type TemplatePrebuildReason =
  | "no-builder"
  | "no-project"
  | "microvm-native"
  | "migrated"
  | "compute-access"
  | "rollout"
  | "none";

export type TemplateBuildOutcome =
  | "built"
  | "already_there"
  | "failed"
  | "timeout"
  | "rate_limited";

/** Why a deploy was or was not eligible, logged when the prebuild is skipped. */
type EligibilityDiagnostics = {
  organizationId?: string;
  workloadType?: string;
  masterQueue?: string;
  hasBacking?: boolean;
  registryRows?: number | "cold";
  migrated?: boolean;
  eligible?: boolean;
};

type TemplateBuildRequestSkip = "no_builder" | "has_key" | "no_pinned_image";

/** Why a 2xx from the builder still ended as `failed`: the key was not written. */
export type TemplateKeyStoreFailure = "invalid_template_id" | "not_stored" | "store_error";

export type TemplateBuildResult =
  | { outcome: Exclude<TemplateBuildOutcome, "failed">; templateKey?: string }
  | { outcome: "failed"; reason?: TemplateKeyStoreFailure };

export type TemplateBuildRequestResult = {
  deploymentId: string;
  friendlyId?: string;
  shortCode?: string;
  projectRef?: string;
  environmentType?: RuntimeEnvironmentType;
  /** The key the deployment has after the request, when it has one. */
  templateKey?: string;
} & (
  | TemplateBuildResult
  | { outcome: "skipped"; reason: TemplateBuildRequestSkip }
  | { outcome: "not_found" }
  | { outcome: "ambiguous" }
);

const BUILD_REQUEST_CONCURRENCY = 10;

export type TemplateBuilderConfig = {
  url?: string;
  token?: string;
  timeoutMs: number;
  presets: MachinePresetName[];
  shadowRolloutPct: number;
  /** Worker groups that are their own compute backing (see selfBackingWorkerGroups). */
  mixedRuntimeWorkerGroups: readonly string[];
  /** Mean wait before retrying a 429 (no free build slot) or 504 (build outlasted the proxy). */
  busyRetryMs?: number;
  /** Ask for the deployment's warmed snapshot (no `no_snap`), which the builder builds before it replies. */
  deploySnapshots?: boolean;
};

// About one build: a builder with every slot taken refuses at once, so a slot frees up as a
// build ends. node-proxy drops fcrun's Retry-After, so the wait is fixed here.
const BUSY_RETRY_MS = 30_000;

export type TemplateCreateRequest = {
  image: string;
  machine_configs: { cpus: number; memory_mb: number }[];
  /** The presets as Runner machines; node-proxy sizes these as runner guests and replaces
   * machine_configs, which stays for a proxy that predates it. */
  machines: { name: string; cpu: string; memory: string }[];
  no_snap?: true;
  deployment_id: string;
  warmup?: string[][];
};

type TemplateCreateResponse = {
  template_id?: string;
  template_source?: string;
  image_pull_ms?: number;
  squashfs_ms?: number;
  error?: string;
};

export function templatePrebuildTelemetry(meter: Meter) {
  return {
    calls: meter.createCounter("deploy.template_prebuild.calls", {
      description: "Template builder calls made at deploy finalisation",
    }),
    skips: meter.createCounter("deploy.template_prebuild.skips", {
      description: "Deploy finalisations that did not call the template builder",
    }),
    duration: meter.createHistogram("deploy.template_prebuild.duration_ms", {
      description: "Template builder call duration",
      unit: "ms",
    }),
  };
}

type TemplatePrebuildTelemetry = ReturnType<typeof templatePrebuildTelemetry>;

const defaultTelemetry = singleton("templatePrebuildTelemetry", () =>
  templatePrebuildTelemetry(getMeter("template-prebuild"))
);

/** The image pinned by digest, or undefined when no valid digest is known. */
export function pinnedImageReference(
  imageReference: string,
  imageDigest: string | undefined
): string | undefined {
  if (/@sha256:[a-f0-9]{64}$/.test(imageReference)) {
    return imageReference;
  }
  const digest = imageDigest?.trim();
  if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    return undefined;
  }
  return `${imageReference}@${digest}`;
}

const WarmupCommand = z.array(z.string().min(1).max(4096)).min(1).max(64);

/**
 * The warmup command a deployed worker's CLI reported, or undefined when it reported none (an older
 * CLI) or one that is not a plain argv.
 */
export function warmupCommandFromMetadata(metadata: unknown): string[] | undefined {
  if (typeof metadata !== "object" || metadata === null || !("warmupCommand" in metadata)) {
    return undefined;
  }
  const parsed = WarmupCommand.safeParse(metadata.warmupCommand);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The presets a deployment's tasks run on: each task's own machine, and the
 * machine it retries on after an OOM (`retry.outOfMemory.machine`), so both
 * restore from a snapshot built at deploy time.
 */
export function deploymentPresets(
  tasks: { machineConfig: unknown; retryConfig: unknown }[]
): MachinePresetName[] {
  const presets = new Set<MachinePresetName>();
  for (const task of tasks) {
    // An unset machine runs on the default, which the configured presets may not hold.
    presets.add(
      task.machineConfig == null ? defaultMachine : machinePresetFromConfig(task.machineConfig).name
    );
    const oom = RetryOptions.safeParse(task.retryConfig).data?.outOfMemory?.machine;
    if (oom) {
      presets.add(oom);
    }
  }
  return [...presets];
}

/** One request per deploy, carrying each distinct preset shape. */
export function templateCreateRequest(
  image: string,
  presets: MachinePresetName[],
  deploymentFriendlyId: string,
  warmupCommand?: string[],
  deploySnapshots = false
): TemplateCreateRequest {
  const shapes = new Map<string, { cpus: number; memory_mb: number }>();
  const machines = new Map<string, { name: string; cpu: string; memory: string }>();
  for (const name of presets) {
    const machine = machinePresetFromName(name);
    const shape = { cpus: machine.cpu, memory_mb: Math.round(machine.memory * 1024) };
    shapes.set(`${shape.cpus}/${shape.memory_mb}`, shape);
    // As the supervisor writes a Runner's machine (runCrd.ts machineOf).
    machines.set(machine.name, {
      name: machine.name,
      cpu: `${machine.cpu}`,
      memory: `${machine.memory}G`,
    });
  }
  return {
    image,
    machine_configs: [...shapes.values()],
    machines: [...machines.values()],
    ...(deploySnapshots ? {} : { no_snap: true as const }),
    deployment_id: deploymentFriendlyId,
    ...(warmupCommand ? { warmup: [warmupCommand] } : {}),
  };
}

/** The builder's template id when it is a valid template key, else undefined. */
export function validTemplateKey(templateId: unknown): string | undefined {
  return typeof templateId === "string" && /^[a-f0-9]{64}$/.test(templateId)
    ? templateId
    : undefined;
}

export class TemplatePrebuildService {
  constructor(
    private readonly prisma: PrismaClientOrTransaction = defaultPrisma,
    private readonly config: TemplateBuilderConfig = {
      url: env.TEMPLATE_BUILDER_URL,
      token: env.TEMPLATE_BUILDER_TOKEN,
      timeoutMs: env.TEMPLATE_BUILDER_TIMEOUT_MS,
      presets: env.TEMPLATE_BUILDER_MACHINE_PRESETS,
      shadowRolloutPct: env.TEMPLATE_BUILDER_SHADOW_ROLLOUT_PCT,
      deploySnapshots: env.TEMPLATE_BUILDER_DEPLOY_SNAPSHOTS,
      mixedRuntimeWorkerGroups: selfBackingWorkerGroups(
        env.RUN_ENGINE_MIXED_RUNTIME_WORKER_GROUPS,
        env.TRIGGER_WORKER_QUEUE_V2_ENABLED === "1"
      ),
    },
    private readonly taskMetaCache: TaskMetadataCache = taskMetadataCacheInstance,
    private readonly telemetry: TemplatePrebuildTelemetry = defaultTelemetry
  ) {}

  /**
   * Prebuild the deployment image's template. Never throws: a template problem
   * must not fail or block a deploy beyond the wait-mode timeout.
   */
  async prebuild(options: {
    projectId: string;
    deploymentId: string;
    deploymentFriendlyId: string;
    imageReference: string;
    imageDigest: string | undefined;
    /** The deployed worker's metadata, which carries its warmup command. */
    workerMetadata?: unknown;
    writer?: WritableStreamDefaultWriter;
    /** Wait for the build whatever the wait flag says, for deployments that cannot run without it. */
    requireTemplate?: boolean;
    /** The deployed worker, whose tasks' presets are built after the configured ones. */
    workerId?: string;
    /** Images of the deployment's named machines, each built into its own template. */
    machineImages?: MachineImage[];
  }): Promise<{
    mode: TemplatePrebuildMode;
    reason?: TemplatePrebuildReason;
    outcome?: TemplateBuildOutcome;
  }> {
    try {
      const { mode, reason, diagnostics } = await this.resolve(
        options.projectId,
        options.requireTemplate
      );
      if (mode === "skip") {
        logger.info("Template prebuild skipped", {
          deploymentId: options.deploymentFriendlyId,
          projectId: options.projectId,
          mode,
          reason,
          ...diagnostics,
        });
        this.telemetry.skips.add(1, { reason, eligible: diagnostics.eligible ?? false });
        return { mode, reason };
      }

      const image = pinnedImageReference(options.imageReference, options.imageDigest);
      if (!image) {
        logger.warn("Template prebuild skipped: deployment image has no digest", {
          deploymentId: options.deploymentFriendlyId,
          imageReference: options.imageReference,
        });
        this.telemetry.skips.add(1, { reason: "no-digest", eligible: true });
        return { mode: "skip", reason };
      }

      const deployment = {
        id: options.deploymentId,
        friendlyId: options.deploymentFriendlyId,
        warmupCommand: warmupCommandFromMetadata(options.workerMetadata),
      };
      const build = this.build(image, mode, deployment);
      // After the deployment's own build, which holds fcrun's node-wide lock while it runs.
      const machineBuilds = build.then(() =>
        this.buildMachineImages(mode, deployment, options.workerId, options.machineImages)
      );
      void machineBuilds.then(() => this.buildTaskPresets(image, deployment, options.workerId));
      if (mode === "shadow") {
        return { mode, reason };
      }
      // Not awaited: a CLI that stops reading would hold finalisation on backpressure.
      options.writer
        ?.write(
          `event: log\ndata: ${JSON.stringify({ message: "Building compute template..." })}\n\n`
        )
        .catch(() => {});
      // The finalizer checks each machine's template, so wait mode waits for them too.
      await machineBuilds;
      return { mode, reason, outcome: (await build).outcome };
    } catch (error) {
      logger.error("Template prebuild failed before calling the builder", {
        deploymentId: options.deploymentFriendlyId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.telemetry.skips.add(1, { reason: "error" });
      return { mode: "skip" };
    }
  }

  async resolveMode(
    projectId: string
  ): Promise<{ mode: TemplatePrebuildMode; reason: TemplatePrebuildReason }> {
    const { mode, reason } = await this.resolve(projectId);
    return { mode, reason };
  }

  // Resolves eligibility even without a builder, so a skip shows whether the deploy would build.
  private async resolve(
    projectId: string,
    requireTemplate = false
  ): Promise<{
    mode: TemplatePrebuildMode;
    reason: TemplatePrebuildReason;
    diagnostics: EligibilityDiagnostics;
  }> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId },
      select: { organization: { select: { id: true, featureFlags: true } } },
    });

    if (!project) {
      return { mode: "skip", reason: "no-project", diagnostics: {} };
    }

    // As on the trigger path, a project without its own default group uses the global one.
    const defaultWorkerGroup = await new WorkerGroupService({
      prisma: this.prisma,
    }).getDefaultWorkerGroupForProject({ projectId });

    const diagnostics: EligibilityDiagnostics = {
      organizationId: project.organization.id,
      workloadType: defaultWorkerGroup?.workloadType,
      masterQueue: defaultWorkerGroup?.masterQueue,
    };
    const reason = await this.eligibility(
      { ...project, defaultWorkerGroup: defaultWorkerGroup ?? null },
      diagnostics
    );
    diagnostics.eligible = reason !== "none";
    if (!this.config.url) {
      return { mode: "skip", reason: "no-builder", diagnostics };
    }
    // Sandbox tasks only run on microVMs, so they need a template whatever the org's rollout state.
    // Trigger still fails clearly if the region has no microVM backing.
    if (requireTemplate) {
      return { mode: "wait", reason, diagnostics };
    }
    if (reason === "none") {
      return { mode: "skip", reason, diagnostics };
    }
    // The rollout only samples orgs without compute, so it never holds their deploys.
    if (reason === "rollout") {
      return { mode: "shadow", reason, diagnostics };
    }

    const wait = await makeFlag(this.prisma)({
      key: FEATURE_FLAG.computeTemplatePrebuildWait,
      defaultValue: false,
      overrides: (project.organization.featureFlags as Record<string, unknown>) ?? {},
    });

    return { mode: wait ? "wait" : "shadow", reason, diagnostics };
  }

  private async eligibility(
    project: {
      defaultWorkerGroup: { workloadType: string; masterQueue: string } | null;
      organization: { id: string; featureFlags: unknown };
    },
    diagnostics: EligibilityDiagnostics
  ): Promise<TemplatePrebuildReason> {
    const groups = workerRegionRegistry.current();
    const defaultQueue = project.defaultWorkerGroup?.masterQueue;
    const backing = defaultQueue
      ? backingForQueue(defaultQueue, groups ?? [], this.config.mixedRuntimeWorkerGroups)
      : undefined;
    diagnostics.registryRows = groups ? groups.length : "cold";
    diagnostics.hasBacking = backing !== undefined;

    if (project.defaultWorkerGroup?.workloadType === "MICROVM") {
      return "microvm-native";
    }

    // Migrated orgs run on the compute backing although their stored default is
    // still the container region. A cold registry read finds no backing, so skips.
    if (backing) {
      const decision = {
        orgId: project.organization.id,
        orgFeatureFlags: project.organization.featureFlags as Record<string, unknown> | null,
        flags: globalFlagsRegistry.current(),
      };
      // Only the percentage path needs the plan, so look it up only when it could matter.
      let migrated = isOrgMigrated({ ...decision, planType: undefined });
      if (!migrated && (decision.flags?.computeMigrationEnabled ?? false)) {
        let planType: string | undefined;
        try {
          planType = (await getEntitlement(project.organization.id))?.plan?.type;
        } catch (error) {
          logger.warn("Template prebuild: entitlement lookup failed", {
            organizationId: project.organization.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        migrated = isOrgMigrated({ ...decision, planType });
      }
      diagnostics.migrated = migrated;
      if (migrated) {
        return "migrated";
      }
    }

    if (await resolveComputeAccess(this.prisma, project.organization.featureFlags)) {
      return "compute-access";
    }

    const pct = this.config.shadowRolloutPct;
    if (pct > 0 && Math.random() * 100 < pct) {
      return "rollout";
    }

    return "none";
  }

  /**
   * Requests a shadow build for each deployment, by id, friendly id or short code, whatever its
   * age. A deployment that has a key is skipped unless `force` is set. The store guard still
   * applies. `timeoutMs` overrides the builder timeout; `onResult` sees each result as it settles.
   */
  async requestBuilds({
    deploymentIds,
    force = false,
    timeoutMs,
    onResult,
  }: {
    deploymentIds: string[];
    force?: boolean;
    timeoutMs?: number;
    onResult?: (result: TemplateBuildRequestResult) => void;
  }): Promise<TemplateBuildRequestResult[]> {
    const results: TemplateBuildRequestResult[] = [];
    for (let i = 0; i < deploymentIds.length; i += BUILD_REQUEST_CONCURRENCY) {
      const batch = deploymentIds.slice(i, i + BUILD_REQUEST_CONCURRENCY);
      results.push(
        ...(await Promise.all(
          batch.map(async (deploymentId) => {
            const result = await this.requestBuild(deploymentId, force, timeoutMs);
            onResult?.(result);
            return result;
          })
        ))
      );
    }
    return results;
  }

  private async requestBuild(
    deploymentId: string,
    force: boolean,
    timeoutMs: number | undefined
  ): Promise<TemplateBuildRequestResult> {
    const select = {
      id: true,
      friendlyId: true,
      shortCode: true,
      imageReference: true,
      templateKey: true,
      machines: { select: { machineId: true, imageReference: true, templateKey: true } },
      worker: { select: { id: true, metadata: true } },
      project: { select: { externalRef: true } },
      environment: { select: { type: true } },
    } satisfies Prisma.WorkerDeploymentSelect;
    const byId = await this.prisma.workerDeployment.findFirst({
      where: { OR: [{ id: deploymentId }, { friendlyId: deploymentId }] },
      select,
    });
    // A short code is unique per project only, so a second match means it is ambiguous. With no
    // project it cannot use the (projectId, shortCode) index, so it is looked up only as a fallback.
    const matches = byId
      ? [byId]
      : await this.prisma.workerDeployment.findMany({
          where: { shortCode: deploymentId },
          select,
          take: 2,
        });
    if (matches.length > 1) {
      return { deploymentId, outcome: "ambiguous" };
    }
    const deployment = matches[0];
    if (!deployment) {
      return { deploymentId, outcome: "not_found" };
    }
    const base = {
      deploymentId,
      friendlyId: deployment.friendlyId,
      shortCode: deployment.shortCode,
      projectRef: deployment.project.externalRef,
      environmentType: deployment.environment.type,
      ...(deployment.templateKey ? { templateKey: deployment.templateKey } : {}),
    };
    if (!this.config.url) {
      return { ...base, outcome: "skipped", reason: "no_builder" };
    }
    const unbuiltMachines = deployment.machines.filter((machine) => force || !machine.templateKey);
    if (deployment.templateKey && !force && unbuiltMachines.length === 0) {
      return { ...base, outcome: "skipped", reason: "has_key" };
    }
    // Finalisation stores the image pinned by digest; without one there is nothing to build.
    const image = deployment.imageReference
      ? pinnedImageReference(deployment.imageReference, undefined)
      : undefined;
    if (!image) {
      return { ...base, outcome: "skipped", reason: "no_pinned_image" };
    }
    // One budget for the deployment, the task presets included.
    const deadline = performance.now() + (timeoutMs ?? this.config.timeoutMs);
    const result = await this.build(
      image,
      "shadow",
      {
        id: deployment.id,
        friendlyId: deployment.friendlyId,
        warmupCommand: warmupCommandFromMetadata(deployment.worker?.metadata),
      },
      timeoutMs
    );
    // Before the task presets: a machine without a template cannot start on compute, while a
    // preset left unbuilt only starts cold.
    const machineOutcomes = await this.buildMachineImages(
      "shadow",
      {
        id: deployment.id,
        friendlyId: deployment.friendlyId,
        warmupCommand: warmupCommandFromMetadata(deployment.worker?.metadata),
      },
      deployment.worker?.id,
      unbuiltMachines,
      deadline - performance.now()
    );
    // Awaited so a caller that waits for rebuilds to settle (compute migration) waits for these
    // too, inside the batch's concurrency limit. Their failures leave shapes cold, so the
    // outcome stays the configured build's.
    await this.buildTaskPresets(
      image,
      {
        id: deployment.id,
        friendlyId: deployment.friendlyId,
        warmupCommand: warmupCommandFromMetadata(deployment.worker?.metadata),
      },
      deployment.worker?.id,
      deadline
    );
    // A machine without a template cannot start on compute, so its failure is the deployment's.
    const machineFailure = machineOutcomes.find(
      (outcome) => outcome !== "built" && outcome !== "already_there"
    );
    if (machineFailure && result.outcome !== "failed") {
      return { ...base, outcome: machineFailure };
    }
    return { ...base, ...result };
  }

  /**
   * Builds the presets the worker's tasks run on that the configured ones do not cover, after the
   * configured build: a deploy that waits for its template key never waits on them, and a failure
   * here only leaves those shapes cold. One preset per request, one after another, because fcrun
   * holds a node-wide lock across a request's shapes, so a key-critical build on that node waits
   * at most one shape. Without deploy snapshots fcrun builds no shape, so nothing is sent.
   * Never rejects.
   */
  private async buildTaskPresets(
    image: string,
    deployment: { id: string; friendlyId: string; warmupCommand?: string[] },
    workerId: string | undefined,
    /** A `performance.now()` time no preset starts after, each getting what is left of it. */
    deadline?: number
  ): Promise<void> {
    const remaining = () => (deadline === undefined ? undefined : deadline - performance.now());
    const spent = () => (remaining() ?? 1) <= 0;
    if (!workerId || !this.config.deploySnapshots || spent()) {
      return;
    }
    try {
      const tasks = await this.prisma.backgroundWorkerTask.findMany({
        where: { workerId },
        select: { machineConfig: true, retryConfig: true },
      });
      const presets = deploymentPresets(
        tasks.filter((task) => !machineNameOf(task.machineConfig))
      ).filter((p) => !this.config.presets.includes(p));
      for (const [index, preset] of presets.entries()) {
        if (spent()) {
          logger.info("Template prebuild ran out of time for task presets", {
            deploymentId: deployment.friendlyId,
            skipped: presets.slice(index),
          });
          break;
        }
        await this.build(image, "shadow", { ...deployment, presets: [preset] }, remaining());
      }
    } catch (error) {
      logger.warn("Template prebuild of task presets failed", {
        deploymentId: deployment.friendlyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Builds each named machine's image with the presets of the tasks on it, one after another, as
   * fcrun locks a node for a whole request. Each key is stored on the deployment under its
   * machine. Never rejects.
   */
  private async buildMachineImages(
    mode: Exclude<TemplatePrebuildMode, "skip">,
    deployment: { id: string; friendlyId: string; warmupCommand?: string[] },
    workerId: string | undefined,
    machines: MachineImage[] | undefined = [],
    timeoutMs?: number
  ): Promise<TemplateBuildOutcome[]> {
    if (!workerId || machines.length === 0) {
      return [];
    }
    const deadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
    const remaining = () => (deadline === undefined ? undefined : deadline - performance.now());
    try {
      const tasks = await this.prisma.backgroundWorkerTask.findMany({
        where: { workerId },
        select: { machineConfig: true, retryConfig: true },
      });
      const outcomes: TemplateBuildOutcome[] = [];
      for (const { machineId, imageReference } of machines) {
        if ((remaining() ?? 1) <= 0) {
          outcomes.push("timeout");
          continue;
        }
        const presets = deploymentPresets(
          tasks.filter((task) => machineNameOf(task.machineConfig) === machineId)
        );
        const result = await this.build(
          imageReference,
          mode,
          { ...deployment, presets: presets.length > 0 ? presets : undefined, machineId },
          remaining()
        );
        outcomes.push(result.outcome);
      }
      return outcomes;
    } catch (error) {
      logger.warn("Template prebuild of machine images failed", {
        deploymentId: deployment.friendlyId,
        error: error instanceof Error ? error.message : String(error),
      });
      return machines.map(() => "failed");
    }
  }

  /**
   * Call the builder once and store the template key on success. Resolves with
   * the outcome, which is `failed` when the key was not written; never rejects.
   */
  async build(
    image: string,
    mode: Exclude<TemplatePrebuildMode, "skip">,
    deployment: {
      id: string;
      friendlyId: string;
      warmupCommand?: string[];
      presets?: MachinePresetName[];
      /** Builds this named machine's image, whose key is stored under the machine. */
      machineId?: string;
    },
    timeoutMs: number = this.config.timeoutMs
  ): Promise<TemplateBuildResult> {
    const startedAt = performance.now();
    const body = templateCreateRequest(
      image,
      deployment.presets ?? this.config.presets,
      deployment.friendlyId,
      deployment.warmupCommand,
      this.config.deploySnapshots
    );
    const log = {
      deploymentId: deployment.friendlyId,
      image,
      mode,
      machineId: deployment.machineId,
    };

    let outcome: TemplateBuildOutcome;
    let reason: TemplateKeyStoreFailure | undefined;
    let templateKey: string | undefined;
    const remaining = () => timeoutMs - (performance.now() - startedAt);
    try {
      const post = () =>
        fetch(new URL("/templates", this.config.url).toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.max(0, Math.floor(remaining()))),
        });
      let response = await post();
      let text = await response.text();
      // Retried while the budget allows. A 429 means the builder started nothing. A 504 is
      // node-proxy giving up on a build that carries on, so asking again joins or finds it. Both
      // wait first, so a gateway answering 504 at once is not hammered.
      while (response.status === 429 || response.status === 504) {
        const wait = (this.config.busyRetryMs ?? BUSY_RETRY_MS) * (0.5 + Math.random());
        if (remaining() <= wait) {
          break;
        }
        await sleep(wait);
        response = await post();
        text = await response.text();
      }
      const parsed = parseResponse(text);

      if (response.ok) {
        outcome =
          parsed?.template_source === "mirror" || parsed?.template_source === "local"
            ? "already_there"
            : "built";
        logger.info("Template prebuild finished", {
          ...log,
          outcome,
          templateId: parsed?.template_id,
          templateSource: parsed?.template_source,
          imagePullMs: parsed?.image_pull_ms,
          squashfsMs: parsed?.squashfs_ms,
        });
        // The write keeps going if it outlasts the timeout, but wait mode stops waiting.
        const write = deployment.machineId
          ? this.storeMachineTemplateKey(
              deployment.id,
              deployment.machineId,
              image,
              parsed?.template_id,
              log
            )
          : this.storeTemplateKey(deployment.id, image, parsed?.template_id, log);
        // The task metadata cache holds only the deployment's own template key.
        const cached = write.then((result) =>
          result === "stored" && !deployment.machineId
            ? this.cacheTemplateKey(deployment.id, parsed?.template_id as string, log)
            : undefined
        );
        const stored = await withinBudget(write, remaining());
        // The cache is best effort, so a slow cache never changes the outcome.
        await withinBudget(cached, remaining());
        if (stored === undefined) {
          outcome = "timeout";
        } else if (stored === "stored") {
          templateKey = validTemplateKey(parsed?.template_id);
        } else {
          outcome = "failed";
          reason = stored;
        }
      } else {
        outcome = response.status === 429 ? "rate_limited" : "failed";
        logger.error("Template prebuild failed", {
          ...log,
          status: response.status,
          error: parsed?.error ?? text.slice(0, 500),
        });
      }
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      outcome = timedOut ? "timeout" : "failed";
      logger.error("Template prebuild failed", {
        ...log,
        outcome,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const attributes = { outcome, mode };
    this.telemetry.calls.add(1, attributes);
    this.telemetry.duration.record(performance.now() - startedAt, attributes);
    if (outcome === "failed") {
      return { outcome, reason };
    }
    return templateKey ? { outcome, templateKey } : { outcome };
  }

  // In shadow mode the deployment may already be DEPLOYED; then only store the key
  // if this call's image is the one finalisation pinned.
  private async storeTemplateKey(
    deploymentId: string,
    image: string,
    templateId: unknown,
    log: Record<string, unknown>
  ): Promise<"stored" | TemplateKeyStoreFailure> {
    const templateKey = validTemplateKey(templateId);
    if (!templateKey) {
      logger.warn("Template prebuild returned no valid template id", {
        ...log,
        templateId: typeof templateId === "string" ? templateId.slice(0, 100) : templateId,
      });
      return "invalid_template_id";
    }
    try {
      const { count } = await this.prisma.workerDeployment.updateMany({
        where: { id: deploymentId, OR: [{ status: "DEPLOYING" }, { imageReference: image }] },
        data: { templateKey },
      });
      if (count === 0) {
        logger.warn("Template prebuild did not store the template key", { ...log, templateKey });
        return "not_stored";
      }
    } catch (error) {
      logger.error("Template prebuild could not store the template key", {
        ...log,
        error: error instanceof Error ? error.message : String(error),
      });
      return "store_error";
    }
    return "stored";
  }

  // Only into the machine's row while it still holds this image.
  private async storeMachineTemplateKey(
    deploymentId: string,
    machineId: string,
    image: string,
    templateId: unknown,
    log: Record<string, unknown>
  ): Promise<"stored" | TemplateKeyStoreFailure> {
    const templateKey = validTemplateKey(templateId);
    if (!templateKey) {
      logger.warn("Template prebuild returned no valid template id", {
        ...log,
        templateId: typeof templateId === "string" ? templateId.slice(0, 100) : templateId,
      });
      return "invalid_template_id";
    }
    try {
      const { count } = await this.prisma.workerDeploymentMachine.updateMany({
        where: { deploymentId, machineId, imageReference: image },
        data: { templateKey },
      });
      if (count === 0) {
        logger.warn("Template prebuild did not store the machine's template key", {
          ...log,
          templateKey,
        });
        return "not_stored";
      }
    } catch (error) {
      logger.error("Template prebuild could not store the machine's template key", {
        ...log,
        error: error instanceof Error ? error.message : String(error),
      });
      return "store_error";
    }
    return "stored";
  }

  // The database is the source of truth; the cache refills from it.
  private async cacheTemplateKey(
    deploymentId: string,
    templateKey: string,
    log: Record<string, unknown>
  ): Promise<void> {
    try {
      const deployment = await this.prisma.workerDeployment.findFirst({
        where: { id: deploymentId },
        select: { workerId: true, environmentId: true },
      });
      if (deployment?.workerId) {
        await this.taskMetaCache.setTemplateKey(
          deployment.environmentId,
          deployment.workerId,
          templateKey
        );
      }
    } catch (error) {
      logger.error("Template prebuild could not cache the template key", {
        ...log,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** The work's result, or undefined when the budget runs out first. */
async function withinBudget<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    work,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
    }),
  ]);
  clearTimeout(timer);
  return result;
}

function parseResponse(text: string): TemplateCreateResponse | undefined {
  try {
    return JSON.parse(text) as TemplateCreateResponse;
  } catch {
    return undefined;
  }
}
