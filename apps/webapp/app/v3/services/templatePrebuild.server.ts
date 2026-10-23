import { getMeter } from "@internal/tracing";
import type { MachinePresetName } from "@trigger.dev/core/v3";
import { prisma as defaultPrisma, type PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { isOrgMigrated } from "~/runEngine/concerns/computeMigration.server";
import { logger } from "~/services/logger.server";
import type { TaskMetadataCache } from "~/services/taskMetadataCache.server";
import { taskMetadataCacheInstance } from "~/services/taskMetadataCacheInstance.server";
import { getEntitlement } from "~/services/platform.v3.server";
import { singleton } from "~/utils/singleton";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";
import { globalFlagsRegistry } from "~/v3/globalFlagsRegistry.server";
import { machinePresetFromName } from "~/v3/machinePresets.server";
import { resolveComputeAccess } from "~/v3/regionAccess.server";
import { backingForQueue, workerRegionRegistry } from "~/v3/workerRegions.server";

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

type TemplateBuildRequestSkip = "no_builder" | "has_key" | "no_pinned_image";

export type TemplateBuildRequestResult = {
  deploymentId: string;
  friendlyId?: string;
} & (
  | { outcome: TemplateBuildOutcome }
  | { outcome: "skipped"; reason: TemplateBuildRequestSkip }
  | { outcome: "not_found" }
);

const BUILD_REQUEST_CONCURRENCY = 10;

export type TemplateBuilderConfig = {
  url?: string;
  token?: string;
  timeoutMs: number;
  presets: MachinePresetName[];
  shadowRolloutPct: number;
};

export type TemplateCreateRequest = {
  image: string;
  machine_configs: { cpus: number; memory_mb: number }[];
  no_snap: true;
  deployment_id: string;
};

type TemplateCreateResponse = {
  template_id?: string;
  template_source?: string;
  image_pull_ms?: number;
  squashfs_ms?: number;
  error?: string;
};

const telemetry = singleton("templatePrebuildTelemetry", () => {
  const meter = getMeter("template-prebuild");
  return {
    calls: meter.createCounter("deploy.template_prebuild.calls", {
      description: "Template builder calls made at deploy finalisation",
    }),
    duration: meter.createHistogram("deploy.template_prebuild.duration_ms", {
      description: "Template builder call duration",
      unit: "ms",
    }),
  };
});

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

/** One request per deploy, carrying each distinct preset shape. */
export function templateCreateRequest(
  image: string,
  presets: MachinePresetName[],
  deploymentFriendlyId: string
): TemplateCreateRequest {
  const shapes = new Map<string, { cpus: number; memory_mb: number }>();
  for (const name of presets) {
    const machine = machinePresetFromName(name);
    const shape = { cpus: machine.cpu, memory_mb: Math.round(machine.memory * 1024) };
    shapes.set(`${shape.cpus}/${shape.memory_mb}`, shape);
  }
  return {
    image,
    machine_configs: [...shapes.values()],
    no_snap: true,
    deployment_id: deploymentFriendlyId,
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
    },
    private readonly taskMetaCache: TaskMetadataCache = taskMetadataCacheInstance
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
    writer?: WritableStreamDefaultWriter;
  }): Promise<{
    mode: TemplatePrebuildMode;
    reason?: TemplatePrebuildReason;
    outcome?: TemplateBuildOutcome;
  }> {
    try {
      const { mode, reason } = await this.resolveMode(options.projectId);
      if (mode === "skip") {
        return { mode, reason };
      }

      const image = pinnedImageReference(options.imageReference, options.imageDigest);
      if (!image) {
        logger.warn("Template prebuild skipped: deployment image has no digest", {
          deploymentId: options.deploymentFriendlyId,
          imageReference: options.imageReference,
        });
        return { mode: "skip", reason };
      }

      const build = this.build(image, mode, {
        id: options.deploymentId,
        friendlyId: options.deploymentFriendlyId,
      });
      if (mode === "shadow") {
        return { mode, reason };
      }
      // Not awaited: a CLI that stops reading would hold finalisation on backpressure.
      options.writer
        ?.write(
          `event: log\ndata: ${JSON.stringify({ message: "Building compute template..." })}\n\n`
        )
        .catch(() => {});
      return { mode, reason, outcome: await build };
    } catch (error) {
      logger.error("Template prebuild failed before calling the builder", {
        deploymentId: options.deploymentFriendlyId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { mode: "skip" };
    }
  }

  async resolveMode(
    projectId: string
  ): Promise<{ mode: TemplatePrebuildMode; reason: TemplatePrebuildReason }> {
    if (!this.config.url) {
      return { mode: "skip", reason: "no-builder" };
    }

    const project = await this.prisma.project.findFirst({
      where: { id: projectId },
      select: {
        defaultWorkerGroup: { select: { workloadType: true, masterQueue: true } },
        organization: { select: { id: true, featureFlags: true } },
      },
    });

    if (!project) {
      return { mode: "skip", reason: "no-project" };
    }

    const reason = await this.eligibility(project);
    if (reason === "none") {
      return { mode: "skip", reason };
    }
    // The rollout only samples orgs without compute, so it never holds their deploys.
    if (reason === "rollout") {
      return { mode: "shadow", reason };
    }

    const wait = await makeFlag(this.prisma)({
      key: FEATURE_FLAG.computeTemplatePrebuildWait,
      defaultValue: false,
      overrides: (project.organization.featureFlags as Record<string, unknown>) ?? {},
    });

    return { mode: wait ? "wait" : "shadow", reason };
  }

  private async eligibility(project: {
    defaultWorkerGroup: { workloadType: string; masterQueue: string } | null;
    organization: { id: string; featureFlags: unknown };
  }): Promise<TemplatePrebuildReason> {
    if (project.defaultWorkerGroup?.workloadType === "MICROVM") {
      return "microvm-native";
    }

    // Migrated orgs run on the compute backing although their stored default is
    // still the container region. A cold registry read finds no backing, so skips.
    const defaultQueue = project.defaultWorkerGroup?.masterQueue;
    if (defaultQueue && backingForQueue(defaultQueue, workerRegionRegistry.current() ?? [])) {
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
   * Requests a shadow build for each deployment, by id or friendly id, whatever its age. A
   * deployment that has a key is skipped unless `force` is set. The store guard still applies.
   */
  async requestBuilds({
    deploymentIds,
    force = false,
  }: {
    deploymentIds: string[];
    force?: boolean;
  }): Promise<TemplateBuildRequestResult[]> {
    const results: TemplateBuildRequestResult[] = [];
    for (let i = 0; i < deploymentIds.length; i += BUILD_REQUEST_CONCURRENCY) {
      const batch = deploymentIds.slice(i, i + BUILD_REQUEST_CONCURRENCY);
      results.push(
        ...(await Promise.all(batch.map((deploymentId) => this.requestBuild(deploymentId, force))))
      );
    }
    return results;
  }

  private async requestBuild(
    deploymentId: string,
    force: boolean
  ): Promise<TemplateBuildRequestResult> {
    const deployment = await this.prisma.workerDeployment.findFirst({
      where: { OR: [{ id: deploymentId }, { friendlyId: deploymentId }] },
      select: { id: true, friendlyId: true, imageReference: true, templateKey: true },
    });
    if (!deployment) {
      return { deploymentId, outcome: "not_found" };
    }
    const base = { deploymentId, friendlyId: deployment.friendlyId };
    if (!this.config.url) {
      return { ...base, outcome: "skipped", reason: "no_builder" };
    }
    if (deployment.templateKey && !force) {
      return { ...base, outcome: "skipped", reason: "has_key" };
    }
    // Finalisation stores the image pinned by digest; without one there is nothing to build.
    const image = deployment.imageReference
      ? pinnedImageReference(deployment.imageReference, undefined)
      : undefined;
    if (!image) {
      return { ...base, outcome: "skipped", reason: "no_pinned_image" };
    }
    const outcome = await this.build(image, "shadow", {
      id: deployment.id,
      friendlyId: deployment.friendlyId,
    });
    return { ...base, outcome };
  }

  /**
   * Call the builder once and store the template key on success. Resolves with
   * the outcome; never rejects.
   */
  async build(
    image: string,
    mode: Exclude<TemplatePrebuildMode, "skip">,
    deployment: { id: string; friendlyId: string }
  ): Promise<TemplateBuildOutcome> {
    const startedAt = performance.now();
    const body = templateCreateRequest(image, this.config.presets, deployment.friendlyId);
    const log = { deploymentId: deployment.friendlyId, image, mode };

    let outcome: TemplateBuildOutcome;
    try {
      const response = await fetch(new URL("/templates", this.config.url).toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      const text = await response.text();
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
        await withinBudget(
          this.storeTemplateKey(deployment.id, image, parsed?.template_id, log),
          this.config.timeoutMs - (performance.now() - startedAt)
        );
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
    telemetry.calls.add(1, attributes);
    telemetry.duration.record(performance.now() - startedAt, attributes);
    return outcome;
  }

  // In shadow mode the deployment may already be DEPLOYED; then only store the key
  // if this call's image is the one finalisation pinned.
  private async storeTemplateKey(
    deploymentId: string,
    image: string,
    templateId: unknown,
    log: Record<string, unknown>
  ): Promise<void> {
    const templateKey = validTemplateKey(templateId);
    if (!templateKey) {
      logger.warn("Template prebuild returned no valid template id", {
        ...log,
        templateId: typeof templateId === "string" ? templateId.slice(0, 100) : templateId,
      });
      return;
    }
    try {
      const { count } = await this.prisma.workerDeployment.updateMany({
        where: { id: deploymentId, OR: [{ status: "DEPLOYING" }, { imageReference: image }] },
        data: { templateKey },
      });
      if (count === 0) {
        logger.warn("Template prebuild did not store the template key", { ...log, templateKey });
        return;
      }
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
      logger.error("Template prebuild could not store the template key", {
        ...log,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function withinBudget(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, ms));
    }),
  ]);
  clearTimeout(timer);
}

function parseResponse(text: string): TemplateCreateResponse | undefined {
  try {
    return JSON.parse(text) as TemplateCreateResponse;
  } catch {
    return undefined;
  }
}
