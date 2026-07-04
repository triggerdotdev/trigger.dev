import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import type {
  PrismaClient,
  PrismaReplicaClient,
  RuntimeEnvironmentType,
} from "@trigger.dev/database";
import { prisma, $replica } from "~/db.server";
import { env } from "~/env.server";
import {
  ControlPlaneCache,
  DEFAULT_CP_CACHE_MAX_ENTRIES,
  DEFAULT_CP_CACHE_TTL_MS,
  type ResolvedAuthenticatedEnv,
  type ResolvedEnv,
  type ResolvedWorkerVersion,
  type ResolvedRunLockedWorker,
} from "./controlPlaneCache.server";
import { authIncludeWithParent, toAuthenticated } from "~/models/runtimeEnvironment.server";

/**
 * App-level control-plane resolution + cache layer. Replaces the run-ops -> control-plane
 * Prisma joins (env/project/org, the pinned/current worker version + its tasks/queues, the
 * TaskQueue, the TaskSchedule friendlyId mapping) with cached lookups against the
 * control-plane client, so the split (cross-DB) hot path avoids a cross-WAN round-trip per
 * resolution.
 *
 * Split ON (cloud): cache-first reads against the control-plane replica; `null` is cached as
 * a confirmed absence. Split OFF (self-host/local/CI): plain Prisma join against the single
 * control-plane client on every call, NO cache — byte-identical to today's inline join.
 *
 * The split gate is a SYNCHRONOUS `splitEnabled: () => boolean` injected at construction; the
 * resolver never awaits the async `isSplitEnabled()` (that gate is reserved for the boot
 * sentinel). Tests inject testcontainer clients + a sync predicate; only the module-level
 * singleton at the bottom reads from `db.server.ts` / `env.server.ts`.
 *
 * Scope boundary: this unit owns ONLY control-plane resolution (env, worker version,
 * env existence). The run-ops batchId friendlyId->id resolution belongs to the
 * run-ops read path (the unit owning `runsRepository.server.ts`); do not duplicate it here.
 */

export { ResolvedEnv, ResolvedWorkerVersion };
export type { ResolvedAuthenticatedEnv, ResolvedRunLockedWorker };

/** Thrown by `assertEnvExists` when a referenced control-plane env does not exist. */
export class ControlPlaneReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneReferenceError";
  }
}

export type ControlPlaneResolverOptions = {
  controlPlanePrimary: PrismaClient;
  controlPlaneReplica: PrismaReplicaClient;
  cache: ControlPlaneCache;
  splitEnabled: () => boolean;
};

type CpClient = PrismaClient | PrismaReplicaClient;

function workerVersionKey(
  environmentId: string,
  backgroundWorkerId: string | undefined,
  type: RuntimeEnvironmentType | undefined
): string {
  return `${environmentId}:${backgroundWorkerId ?? "current"}:${type ?? "any"}`;
}

function lockedWorkerKey(lockedById?: string | null, lockedToVersionId?: string | null): string {
  return `${lockedById ?? "_"}:${lockedToVersionId ?? "_"}`;
}

export class ControlPlaneResolver {
  private readonly controlPlanePrimary: PrismaClient;
  private readonly controlPlaneReplica: PrismaReplicaClient;
  private readonly cache: ControlPlaneCache;
  private readonly splitEnabled: () => boolean;

  constructor(opts: ControlPlaneResolverOptions) {
    this.controlPlanePrimary = opts.controlPlanePrimary;
    this.controlPlaneReplica = opts.controlPlaneReplica;
    this.cache = opts.cache;
    this.splitEnabled = opts.splitEnabled;
  }

  async resolveEnv(environmentId: string): Promise<ResolvedEnv | null> {
    if (!this.splitEnabled()) {
      return this.#queryEnv(this.controlPlanePrimary, environmentId);
    }

    const cached = this.cache.getEnv(environmentId);
    if (cached !== undefined) {
      return cached;
    }

    const resolved = await this.#queryEnv(this.controlPlaneReplica, environmentId);
    this.cache.setEnv(environmentId, resolved);
    return resolved;
  }

  async #queryEnv(client: CpClient, environmentId: string): Promise<ResolvedEnv | null> {
    const env = await client.runtimeEnvironment.findFirst({
      where: { id: environmentId },
      select: {
        id: true,
        type: true,
        projectId: true,
        archivedAt: true,
        maximumConcurrencyLimit: true,
        concurrencyLimitBurstFactor: true,
        project: { select: { organizationId: true } },
        parentEnvironment: { select: { type: true } },
      },
    });

    if (!env) {
      return null;
    }

    return {
      id: env.id,
      type: env.type,
      projectId: env.projectId,
      organizationId: env.project.organizationId,
      archivedAt: env.archivedAt,
      parentEnvironmentType: env.parentEnvironment?.type ?? null,
      maximumConcurrencyLimit: env.maximumConcurrencyLimit,
      concurrencyLimitBurstFactor: env.concurrencyLimitBurstFactor,
    };
  }

  async resolveAuthenticatedEnv(environmentId: string): Promise<ResolvedAuthenticatedEnv | null> {
    if (!this.splitEnabled()) {
      return this.#queryAuthenticatedEnv(this.controlPlanePrimary, environmentId);
    }

    const cached = this.cache.getAuthEnv(environmentId);
    if (cached !== undefined) {
      return cached;
    }

    const resolved = await this.#queryAuthenticatedEnv(this.controlPlaneReplica, environmentId);
    this.cache.setAuthEnv(environmentId, resolved);
    return resolved;
  }

  async #queryAuthenticatedEnv(
    client: CpClient,
    environmentId: string
  ): Promise<ResolvedAuthenticatedEnv | null> {
    const env = await client.runtimeEnvironment.findFirst({
      where: { id: environmentId },
      include: authIncludeWithParent,
    });

    if (!env) {
      return null;
    }

    // `authIncludeWithParent` returns all RuntimeEnvironment scalars on the row (including
    // `git`), so we map the auth shape via toAuthenticated() and add `git` from the same row.
    return { ...toAuthenticated(env), git: env.git };
  }

  async resolveRunLockedWorker(args: {
    lockedById?: string | null;
    lockedToVersionId?: string | null;
  }): Promise<ResolvedRunLockedWorker | null> {
    const { lockedById, lockedToVersionId } = args;

    if (!this.splitEnabled()) {
      return this.#queryRunLockedWorker(this.controlPlanePrimary, lockedById, lockedToVersionId);
    }

    const key = lockedWorkerKey(lockedById, lockedToVersionId);
    const cached = this.cache.getLockedWorker(key);
    if (cached !== undefined) {
      return cached;
    }

    const resolved = await this.#queryRunLockedWorker(
      this.controlPlaneReplica,
      lockedById,
      lockedToVersionId
    );
    this.cache.setLockedWorker(key, resolved);
    return resolved;
  }

  async #queryRunLockedWorker(
    client: CpClient,
    lockedById?: string | null,
    lockedToVersionId?: string | null
  ): Promise<ResolvedRunLockedWorker | null> {
    const lockedByRow = lockedById
      ? await client.backgroundWorkerTask.findFirst({
          where: { id: lockedById },
          select: {
            id: true,
            filePath: true,
            exportName: true,
            slug: true,
            machineConfig: true,
            worker: {
              select: {
                id: true,
                version: true,
                sdkVersion: true,
                cliVersion: true,
                supportsLazyAttempts: true,
                deployment: {
                  select: {
                    friendlyId: true,
                    shortCode: true,
                    version: true,
                    runtime: true,
                    runtimeVersion: true,
                    git: true,
                  },
                },
              },
            },
          },
        })
      : null;

    const lockedToVersionRow = lockedToVersionId
      ? await client.backgroundWorker.findFirst({
          where: { id: lockedToVersionId },
          select: {
            version: true,
            sdkVersion: true,
            runtime: true,
            runtimeVersion: true,
            supportsLazyAttempts: true,
          },
        })
      : null;

    return {
      lockedBy: lockedByRow,
      lockedToVersion: lockedToVersionRow,
    };
  }

  async resolveWorkerVersion(args: {
    environmentId: string;
    backgroundWorkerId?: string;
    /**
     * When provided, the full run-engine dequeue dispatch is used (DEV resolves the most-recent
     * worker; deployed resolves the promoted MANAGED deployment with the latest-v2 fallback).
     * When omitted, the original app behavior applies (worker-by-id, else current promotion).
     */
    type?: RuntimeEnvironmentType;
  }): Promise<ResolvedWorkerVersion | null> {
    const { environmentId, backgroundWorkerId, type } = args;

    if (!this.splitEnabled()) {
      return this.#queryWorkerVersion(
        this.controlPlanePrimary,
        environmentId,
        backgroundWorkerId,
        type
      );
    }

    const key = workerVersionKey(environmentId, backgroundWorkerId, type);
    const cached = this.cache.getWorkerVersion(key);
    if (cached !== undefined) {
      return cached;
    }

    const resolved = await this.#queryWorkerVersion(
      this.controlPlaneReplica,
      environmentId,
      backgroundWorkerId,
      type
    );
    this.cache.setWorkerVersion(key, resolved);
    return resolved;
  }

  async #queryWorkerVersion(
    client: CpClient,
    environmentId: string,
    backgroundWorkerId?: string,
    type?: RuntimeEnvironmentType
  ): Promise<ResolvedWorkerVersion | null> {
    // Full run-engine dequeue dispatch (mirrors dequeueSystem's four helpers) when the env type is
    // known. DEVELOPMENT envs resolve by most-recent worker; deployed envs resolve the promoted
    // MANAGED deployment.
    if (type === "DEVELOPMENT") {
      return backgroundWorkerId
        ? this.#queryWorkerById(client, backgroundWorkerId)
        : this.#queryMostRecentWorker(client, environmentId);
    }

    if (backgroundWorkerId) {
      const worker = await client.backgroundWorker.findFirst({
        where: { id: backgroundWorkerId },
        include: { deployment: true, tasks: true, queues: true },
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

    // Deployed env, no workerId: resolve the currently-promoted deployment's worker. When `type`
    // is known (engine dispatch) apply the MANAGED guard + latest-v2 fallback that the run-engine
    // path requires; without `type` keep the original app behavior (return the promoted worker).
    const promotion = await client.workerDeploymentPromotion.findFirst({
      where: { environmentId, label: CURRENT_DEPLOYMENT_LABEL },
      include: {
        deployment: {
          include: { worker: { include: { tasks: true, queues: true } } },
        },
      },
    });

    if (!promotion?.deployment.worker) {
      return null;
    }

    if (type === undefined || promotion.deployment.type === "MANAGED") {
      return {
        worker: promotion.deployment.worker,
        tasks: promotion.deployment.worker.tasks,
        queues: promotion.deployment.worker.queues,
        deployment: promotion.deployment,
      };
    }

    // Engine dispatch only: the promoted deployment is not run-engine v2; fall back to the latest
    // MANAGED deployment.
    const latestV2Deployment = await client.workerDeployment.findFirst({
      where: { environmentId, type: "MANAGED" },
      orderBy: { id: "desc" },
      include: { worker: { include: { tasks: true, queues: true } } },
    });

    if (!latestV2Deployment?.worker) {
      return null;
    }

    return {
      worker: latestV2Deployment.worker,
      tasks: latestV2Deployment.worker.tasks,
      queues: latestV2Deployment.worker.queues,
      deployment: latestV2Deployment,
    };
  }

  async #queryWorkerById(
    client: CpClient,
    workerId: string
  ): Promise<ResolvedWorkerVersion | null> {
    const worker = await client.backgroundWorker.findFirst({
      where: { id: workerId },
      include: { deployment: true, tasks: true, queues: true },
      orderBy: { id: "desc" },
    });

    if (!worker) {
      return null;
    }

    return { worker, tasks: worker.tasks, queues: worker.queues, deployment: worker.deployment };
  }

  async #queryMostRecentWorker(
    client: CpClient,
    environmentId: string
  ): Promise<ResolvedWorkerVersion | null> {
    const worker = await client.backgroundWorker.findFirst({
      where: { runtimeEnvironmentId: environmentId },
      include: { tasks: true, queues: true },
      orderBy: { id: "desc" },
    });

    if (!worker) {
      return null;
    }

    return { worker, tasks: worker.tasks, queues: worker.queues, deployment: null };
  }

  async assertEnvExists(environmentId: string): Promise<void> {
    if (!this.splitEnabled()) {
      // Split OFF = single DB, so run and env are co-located and there is no FK/check
      // to replace (matches main). Skip the hot-path read entirely.
      return;
    }

    const cached = this.cache.getEnvExists(environmentId);
    if (cached !== undefined) {
      if (!cached) {
        throw new ControlPlaneReferenceError(
          `Referenced environment does not exist: ${environmentId}`
        );
      }
      return;
    }

    const exists = await this.#queryEnvExists(this.controlPlaneReplica, environmentId);
    this.cache.setEnvExists(environmentId, exists);
    if (!exists) {
      throw new ControlPlaneReferenceError(
        `Referenced environment does not exist: ${environmentId}`
      );
    }
  }

  async #queryEnvExists(client: CpClient, environmentId: string): Promise<boolean> {
    const env = await client.runtimeEnvironment.findFirst({
      where: { id: environmentId },
      select: { id: true },
    });
    return env !== null;
  }

  /**
   * Drop cached control-plane rows for one environment after a control-plane write to that
   * env's config. A no-op when split is OFF (nothing is cached), so it is always safe to call.
   */
  invalidateEnvironment(environmentId: string): void {
    this.cache.invalidateEnvironment(environmentId);
  }

  /**
   * Drop cached env/authEnv rows for every environment of an organization after a
   * control-plane write to that org's config. Safe under split OFF (no cache).
   */
  invalidateOrganization(organizationId: string): void {
    this.cache.invalidateOrganization(organizationId);
  }
}

// Module-level singleton: wires the real control-plane clients + env split predicate.
// The control-plane writer/replica are the unchanged `prisma` / `$replica` exports. The
// split decision is a boot constant derived once from the env predicate (same one the
// run-ops topology factory uses); the async isSplitEnabled() distinct-DB sentinel is enforced
// at boot elsewhere and is never awaited on a resolver hot path.
const SPLIT_ENABLED =
  env.RUN_OPS_SPLIT_ENABLED && !!env.RUN_OPS_DATABASE_URL && !!env.RUN_OPS_LEGACY_DATABASE_URL;

export const controlPlaneResolver = new ControlPlaneResolver({
  controlPlanePrimary: prisma,
  controlPlaneReplica: $replica,
  // Relax the cache via config. Unset env knobs -> built-in defaults (byte-identical).
  cache: new ControlPlaneCache({
    ttlMs: env.CONTROL_PLANE_CACHE_TTL_MS ?? DEFAULT_CP_CACHE_TTL_MS,
    maxEntries: env.CONTROL_PLANE_CACHE_MAX_ENTRIES ?? DEFAULT_CP_CACHE_MAX_ENTRIES,
  }),
  splitEnabled: () => SPLIT_ENABLED,
});
