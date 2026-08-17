import type {
  BackgroundWorker,
  Prisma,
  PrismaClient,
  RuntimeEnvironmentType,
} from "@trigger.dev/database";
import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import type { AuthenticatedEnvironment } from "@trigger.dev/core/v3/auth/environment";

/**
 * Read-side analogue of the `runStore` seam.
 *
 * Each of the 5 run-rooted reads that threaded control-plane data through a single
 * Prisma `include` (env/project/org, the worker version + its tasks/queues) was an
 * in-DB join today but a broken cross-provider join once the run-ops DB splits. This
 * resolver lets the consumer read the run-ops scalars via `runStore` and resolve the
 * control-plane half here, so no cross-DB join is required.
 *
 * The default `PassthroughControlPlaneResolver` runs the SAME in-DB joins as before
 * against a single client, so single-DB / self-host behaviour is byte-identical. The
 * webapp injects an adapter over its cached cross-DB resolver.
 */

/**
 * The control-plane half of an environment, carrying BOTH the flat scalars some
 * consumers read AND the nested shape required by `MinimalAuthenticatedEnvironment`,
 * so a `ResolvedEngineEnv` is a structural supertype of it and can be passed directly
 * to `enqueueSystem.enqueueRun({ env })`. `concurrencyLimitBurstFactor` stays a
 * `Prisma.Decimal` (do NOT coerce); `maximumConcurrencyLimit` is non-null per schema.
 */
export type ResolvedEngineEnv = {
  id: string;
  type: RuntimeEnvironmentType;
  archivedAt: Date | null;
  maximumConcurrencyLimit: number;
  concurrencyLimitBurstFactor: Prisma.Decimal;
  projectId: string;
  organizationId: string;
  project: { id: string };
  organization: { id: string };
};

/**
 * The richer control-plane env primitive: the slim, structural
 * `AuthenticatedEnvironment` (slug/branchName/project/organization/…) PLUS the
 * `git` JSON column that the runAttemptSystem reads via `safeParseGitMeta`.
 * `AuthenticatedEnvironment` does not carry `git`, so the intersection adds it.
 */
export type ResolvedAuthenticatedEnv = AuthenticatedEnvironment & { git: Prisma.JsonValue | null };

/**
 * The BackgroundWorkerTask columns the dequeue resolve path actually reads. The worker's
 * whole task set (~73 rows) is fetched for one matched task, so pulling the unread heavy
 * JSON columns (`payloadSchema`, `config`, `queueConfig`, `description`) shipped ~62KB/query
 * on the hottest control-plane read. `machineConfig`/`retryConfig` are read at dequeue and stay.
 */
export type ResolvedWorkerTask = {
  id: string;
  slug: string;
  machineConfig: Prisma.JsonValue | null;
  retryConfig: Prisma.JsonValue | null;
  maxDurationInSeconds: number | null;
};

/** The `select` that yields a `ResolvedWorkerTask`. */
const resolvedWorkerTaskSelect = {
  id: true,
  slug: true,
  machineConfig: true,
  retryConfig: true,
  maxDurationInSeconds: true,
} satisfies Prisma.BackgroundWorkerTaskSelect;

/**
 * The TaskQueue columns the dequeue resolve path uses: `id` and `name` (the matcher keys on
 * `lockedQueueId`/`name`). Drops the unread `rateLimit` JSON and the concurrency/type scalars.
 */
export type ResolvedTaskQueue = {
  id: string;
  name: string;
};

/** The `select` that yields a `ResolvedTaskQueue`. */
export const resolvedTaskQueueSelect = {
  id: true,
  name: true,
} satisfies Prisma.TaskQueueSelect;

/**
 * The WorkerDeployment columns the dequeue resolve path reads: `id`, `friendlyId`,
 * `imageReference`, `imagePlatform`. Drops the unread heavy JSON columns (`externalBuildData`,
 * `buildServerMetadata`, `errorData`, `git`) that this single-row read otherwise ships.
 */
export type ResolvedWorkerDeployment = {
  id: string;
  friendlyId: string;
  imageReference: string | null;
  imagePlatform: string;
};

/** The `select` that yields a `ResolvedWorkerDeployment`. */
export const resolvedWorkerDeploymentSelect = {
  id: true,
  friendlyId: true,
  imageReference: true,
  imagePlatform: true,
} satisfies Prisma.WorkerDeploymentSelect;

/** Identical to dequeue's `WorkerDeploymentWithWorkerTasks`. */
export type ResolvedWorkerVersion = {
  worker: BackgroundWorker;
  tasks: ResolvedWorkerTask[];
  queues: ResolvedTaskQueue[];
  deployment: ResolvedWorkerDeployment | null;
};

/**
 * Optional dispatch filter threaded from the dequeue consumer. When present, the resolve fetches
 * ONLY the task matching `taskIdentifier` and the queue matching `queue` (index point-lookups via
 * `@@unique([workerId, slug])` / `@@unique([runtimeEnvironmentId, name])`) instead of the worker's
 * whole task/queue set. Absent (any non-dequeue caller) keeps the full-set behaviour.
 */
export type WorkerVersionDispatchFilter = {
  taskIdentifier?: string;
  queue?: { lockedQueueId?: string | null; name: string };
};

export interface ControlPlaneResolver {
  resolveEnv(environmentId: string): Promise<ResolvedEngineEnv | null>;
  resolveAuthenticatedEnv(environmentId: string): Promise<ResolvedAuthenticatedEnv | null>;
  resolveWorkerVersion(
    args: {
      environmentId: string;
      type: RuntimeEnvironmentType;
      workerId?: string;
    } & WorkerVersionDispatchFilter
  ): Promise<ResolvedWorkerVersion | null>;
  assertEnvExists(environmentId: string): Promise<void>;
}

type WorkerVersionWheres = {
  taskWhere: { slug: string } | undefined;
  queueWhere: { id: string } | { name: string } | undefined;
};

/** Build the nested-include `where`s for a dispatch filter (undefined = fetch the whole set). */
export function workerVersionWheres(filter: WorkerVersionDispatchFilter): WorkerVersionWheres {
  return {
    taskWhere: filter.taskIdentifier ? { slug: filter.taskIdentifier } : undefined,
    queueWhere: filter.queue
      ? filter.queue.lockedQueueId
        ? { id: filter.queue.lockedQueueId }
        : { name: filter.queue.name }
      : undefined,
  };
}

export class PassthroughControlPlaneResolver implements ControlPlaneResolver {
  readonly #prisma: PrismaClient;

  constructor(opts: { prisma: PrismaClient }) {
    // Reads go through the primary client to stay snapshot-consistent with the run row the
    // consumers read on `prisma`/tx, so passthrough is byte-identical to the prior in-DB include.
    this.#prisma = opts.prisma;
  }

  async resolveEnv(environmentId: string): Promise<ResolvedEngineEnv | null> {
    const env = await this.#prisma.runtimeEnvironment.findFirst({
      where: { id: environmentId },
      select: {
        id: true,
        type: true,
        archivedAt: true,
        maximumConcurrencyLimit: true,
        concurrencyLimitBurstFactor: true,
        projectId: true,
        project: { select: { id: true, organizationId: true } },
        organization: { select: { id: true } },
      },
    });

    if (!env) {
      return null;
    }

    return {
      id: env.id,
      type: env.type,
      archivedAt: env.archivedAt,
      maximumConcurrencyLimit: env.maximumConcurrencyLimit,
      concurrencyLimitBurstFactor: env.concurrencyLimitBurstFactor,
      projectId: env.projectId,
      organizationId: env.project.organizationId,
      project: { id: env.project.id },
      organization: { id: env.organization.id },
    };
  }

  async resolveAuthenticatedEnv(environmentId: string): Promise<ResolvedAuthenticatedEnv | null> {
    const env = await this.#prisma.runtimeEnvironment.findFirst({
      where: { id: environmentId },
      include: {
        project: true,
        organization: true,
        orgMember: {
          select: {
            userId: true,
            user: { select: { id: true, displayName: true, name: true } },
          },
        },
      },
    });

    if (!env) {
      return null;
    }

    return {
      id: env.id,
      slug: env.slug,
      type: env.type,
      apiKey: env.apiKey,
      organizationId: env.organizationId,
      projectId: env.projectId,
      orgMemberId: env.orgMemberId,
      parentEnvironmentId: env.parentEnvironmentId,
      branchName: env.branchName,
      archivedAt: env.archivedAt,
      paused: env.paused,
      shortcode: env.shortcode,
      maximumConcurrencyLimit: env.maximumConcurrencyLimit,
      // Coerce Prisma's Decimal to a plain number — mirrors toAuthenticated().
      concurrencyLimitBurstFactor: env.concurrencyLimitBurstFactor.toNumber(),
      builtInEnvironmentVariableOverrides: env.builtInEnvironmentVariableOverrides,
      createdAt: env.createdAt,
      updatedAt: env.updatedAt,
      project: {
        id: env.project.id,
        slug: env.project.slug,
        name: env.project.name,
        externalRef: env.project.externalRef,
        engine: env.project.engine,
        deletedAt: env.project.deletedAt,
        defaultWorkerGroupId: env.project.defaultWorkerGroupId,
        organizationId: env.project.organizationId,
        builderProjectId: env.project.builderProjectId,
      },
      organization: {
        id: env.organization.id,
        slug: env.organization.slug,
        title: env.organization.title,
        streamBasinName: env.organization.streamBasinName,
        maximumConcurrencyLimit: env.organization.maximumConcurrencyLimit,
        runsEnabled: env.organization.runsEnabled,
        maximumDevQueueSize: env.organization.maximumDevQueueSize,
        maximumDeployedQueueSize: env.organization.maximumDeployedQueueSize,
        featureFlags: env.organization.featureFlags,
        apiRateLimiterConfig: env.organization.apiRateLimiterConfig,
        batchRateLimitConfig: env.organization.batchRateLimitConfig,
        batchQueueConcurrencyConfig: env.organization.batchQueueConcurrencyConfig,
      },
      orgMember: env.orgMember,
      parentEnvironment: null,
      git: env.git,
    };
  }

  async assertEnvExists(_environmentId: string): Promise<void> {
    // No-op: passthrough is single-DB, so run and env share one database and there is
    // no cross-seam FK to replace (matches main, which dropped the TaskRun env FK).
  }

  async resolveWorkerVersion(
    args: {
      environmentId: string;
      type: RuntimeEnvironmentType;
      workerId?: string;
    } & WorkerVersionDispatchFilter
  ): Promise<ResolvedWorkerVersion | null> {
    const { environmentId, type, workerId } = args;
    const wheres = workerVersionWheres(args);

    if (type === "DEVELOPMENT") {
      return workerId
        ? this.#getWorkerById(workerId, wheres)
        : this.#getMostRecentWorker(environmentId, wheres);
    }

    return workerId
      ? this.#getWorkerDeploymentFromWorker(workerId, wheres)
      : this.#getManagedWorkerFromCurrentlyPromotedDeployment(environmentId, wheres);
  }

  async #getWorkerDeploymentFromWorker(
    workerId: string,
    wheres: WorkerVersionWheres
  ): Promise<ResolvedWorkerVersion | null> {
    const worker = await this.#prisma.backgroundWorker.findFirst({
      where: {
        id: workerId,
      },
      include: {
        deployment: { select: resolvedWorkerDeploymentSelect },
        tasks: { where: wheres.taskWhere, select: resolvedWorkerTaskSelect },
        queues: { where: wheres.queueWhere, select: resolvedTaskQueueSelect },
      },
    });

    if (!worker) {
      return null;
    }

    return {
      worker,
      tasks: worker.tasks,
      queues: worker.queues,
      deployment: worker.deployment,
    };
  }

  async #getMostRecentWorker(
    environmentId: string,
    wheres: WorkerVersionWheres
  ): Promise<ResolvedWorkerVersion | null> {
    const worker = await this.#prisma.backgroundWorker.findFirst({
      where: {
        runtimeEnvironmentId: environmentId,
      },
      include: {
        tasks: { where: wheres.taskWhere, select: resolvedWorkerTaskSelect },
        queues: { where: wheres.queueWhere, select: resolvedTaskQueueSelect },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    if (!worker) {
      return null;
    }

    return { worker, tasks: worker.tasks, queues: worker.queues, deployment: null };
  }

  async #getWorkerById(
    workerId: string,
    wheres: WorkerVersionWheres
  ): Promise<ResolvedWorkerVersion | null> {
    const worker = await this.#prisma.backgroundWorker.findFirst({
      where: {
        id: workerId,
      },
      include: {
        deployment: { select: resolvedWorkerDeploymentSelect },
        tasks: { where: wheres.taskWhere, select: resolvedWorkerTaskSelect },
        queues: { where: wheres.queueWhere, select: resolvedTaskQueueSelect },
      },
    });

    if (!worker) {
      return null;
    }

    return {
      worker,
      tasks: worker.tasks,
      queues: worker.queues,
      deployment: worker.deployment,
    };
  }

  async #getManagedWorkerFromCurrentlyPromotedDeployment(
    environmentId: string,
    wheres: WorkerVersionWheres
  ): Promise<ResolvedWorkerVersion | null> {
    const promotion = await this.#prisma.workerDeploymentPromotion.findFirst({
      where: {
        environmentId,
        label: CURRENT_DEPLOYMENT_LABEL,
      },
      include: {
        deployment: {
          select: {
            ...resolvedWorkerDeploymentSelect,
            type: true,
            worker: {
              include: {
                tasks: { where: wheres.taskWhere, select: resolvedWorkerTaskSelect },
                queues: { where: wheres.queueWhere, select: resolvedTaskQueueSelect },
              },
            },
          },
        },
      },
    });

    if (!promotion || !promotion.deployment.worker) {
      return null;
    }

    if (promotion.deployment.type === "MANAGED") {
      // This is a run engine v2 deployment, so return it
      const { worker } = promotion.deployment;
      return {
        worker,
        tasks: worker.tasks,
        queues: worker.queues,
        deployment: {
          id: promotion.deployment.id,
          friendlyId: promotion.deployment.friendlyId,
          imageReference: promotion.deployment.imageReference,
          imagePlatform: promotion.deployment.imagePlatform,
        },
      };
    }

    // We need to get the latest run engine v2 deployment
    const latestV2Deployment = await this.#prisma.workerDeployment.findFirst({
      where: {
        environmentId,
        type: "MANAGED",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        ...resolvedWorkerDeploymentSelect,
        worker: {
          include: {
            tasks: { where: wheres.taskWhere, select: resolvedWorkerTaskSelect },
            queues: { where: wheres.queueWhere, select: resolvedTaskQueueSelect },
          },
        },
      },
    });

    if (!latestV2Deployment?.worker) {
      return null;
    }

    return {
      worker: latestV2Deployment.worker,
      tasks: latestV2Deployment.worker.tasks,
      queues: latestV2Deployment.worker.queues,
      deployment: {
        id: latestV2Deployment.id,
        friendlyId: latestV2Deployment.friendlyId,
        imageReference: latestV2Deployment.imageReference,
        imagePlatform: latestV2Deployment.imagePlatform,
      },
    };
  }
}
