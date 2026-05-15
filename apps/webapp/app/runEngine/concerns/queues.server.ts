import { sanitizeQueueName } from "@trigger.dev/core/v3/isomorphic";
import { PrismaClientOrTransaction } from "@trigger.dev/database";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
import {
  LockedBackgroundWorker,
  QueueManager,
  QueueProperties,
  QueueValidationResult,
  TriggerTaskRequest,
} from "../types";
import { WorkerGroupService } from "~/v3/services/worker/workerGroupService.server";
import type { RunEngine } from "~/v3/runEngine.server";
import { env } from "~/env.server";
import { tryCatch } from "@trigger.dev/core/v3";
import { ServiceValidationError } from "~/v3/services/common.server";
import { createCache, createLRUMemoryStore, DefaultStatefulContext, Namespace } from "@internal/cache";
import { singleton } from "~/utils/singleton";
import type { TaskMetadataCache, TaskMetadataEntry } from "~/services/taskMetadataCache.server";
import { taskMetadataCacheInstance } from "~/services/taskMetadataCacheInstance.server";

// LRU cache for environment queue sizes to reduce Redis calls
const queueSizeCache = singleton("queueSizeCache", () => {
  const ctx = new DefaultStatefulContext();
  const memory = createLRUMemoryStore(env.QUEUE_SIZE_CACHE_MAX_SIZE, "queue-size-cache");

  return createCache({
    queueSize: new Namespace<number>(ctx, {
      stores: [memory],
      fresh: env.QUEUE_SIZE_CACHE_TTL_MS,
      stale: env.QUEUE_SIZE_CACHE_TTL_MS + 1000,
    }),
  });
});

/**
 * Extract the queue name from a queue option that may be:
 * - An object with a string `name` property: { name: "queue-name" }
 * - A double-wrapped object (bug case): { name: { name: "queue-name", ... } }
 *
 * This handles the case where the SDK accidentally double-wraps the queue
 * option when it's already an object with a name property.
 */
function extractQueueName(queue: { name?: unknown } | undefined): string | undefined {
  if (!queue?.name) {
    return undefined;
  }

  // Normal case: queue.name is a string
  if (typeof queue.name === "string") {
    return queue.name;
  }

  // Double-wrapped case: queue.name is an object with its own name property
  if (typeof queue.name === "object" && queue.name !== null && "name" in queue.name) {
    const innerName = (queue.name as { name: unknown }).name;
    if (typeof innerName === "string") {
      return innerName;
    }
  }

  return undefined;
}

export class DefaultQueueManager implements QueueManager {
  private readonly replicaPrisma: PrismaClientOrTransaction;
  private readonly taskMetaCache: TaskMetadataCache;

  constructor(
    private readonly prisma: PrismaClientOrTransaction,
    private readonly engine: RunEngine,
    replicaPrisma?: PrismaClientOrTransaction,
    taskMetaCache: TaskMetadataCache = taskMetadataCacheInstance
  ) {
    this.replicaPrisma = replicaPrisma ?? prisma;
    this.taskMetaCache = taskMetaCache;
  }

  async resolveQueueProperties(
    request: TriggerTaskRequest,
    lockedBackgroundWorker?: LockedBackgroundWorker
  ): Promise<QueueProperties> {
    let queueName: string;
    let lockedQueueId: string | undefined;
    let taskTtl: string | null | undefined;
    let taskKind: string | undefined;

    // Determine queue name based on lockToVersion and provided options
    if (lockedBackgroundWorker) {
      // Task is locked to a specific worker version
      const specifiedQueueName = extractQueueName(request.body.options?.queue);

      if (specifiedQueueName) {
        // A specific queue name is provided, validate it exists for the locked worker.
        // Pre-existing query — not cached because TaskQueue rows can be added or
        // removed independently of BackgroundWorkerTask, and a stale "queue exists"
        // claim would silently route to the wrong queue.
        const specifiedQueue = await this.prisma.taskQueue.findFirst({
          where: {
            name: specifiedQueueName,
            runtimeEnvironmentId: request.environment.id,
            workers: { some: { id: lockedBackgroundWorker.id } },
          },
        });

        if (!specifiedQueue) {
          throw new ServiceValidationError(
            `Specified queue '${specifiedQueueName}' not found or not associated with locked version '${lockedBackgroundWorker.version ?? "<unknown>"
            }'.`
          );
        }

        // Use the validated queue name directly
        queueName = specifiedQueue.name;
        lockedQueueId = specifiedQueue.id;

        // Pull `triggerSource` (for `taskKind` annotation) and `ttl` from cache.
        // On cache hit this is 0 PG queries; on miss the helper falls back to
        // a BackgroundWorkerTask lookup and back-fills the cache.
        const lockedMeta = await this.resolveLockedTaskMetadata(
          lockedBackgroundWorker.id,
          request.environment.id,
          request.taskId
        );

        if (request.body.options?.ttl === undefined) {
          taskTtl = lockedMeta?.ttl ?? undefined;
        }
        taskKind = lockedMeta?.triggerSource;
      } else {
        // No queue override - resolve default queue + TTL + triggerSource via cache,
        // falling back to a single BackgroundWorkerTask lookup on miss.
        const lockedMeta = await this.resolveLockedTaskMetadata(
          lockedBackgroundWorker.id,
          request.environment.id,
          request.taskId
        );

        if (!lockedMeta) {
          throw new ServiceValidationError(
            `Task '${request.taskId}' not found on locked version '${lockedBackgroundWorker.version ?? "<unknown>"
            }'.`
          );
        }

        taskTtl = lockedMeta.ttl;

        if (!lockedMeta.queueName) {
          // This case should ideally be prevented by earlier checks or schema constraints,
          // but handle it defensively.
          logger.error("Task found on locked version, but has no associated queue record", {
            taskId: request.taskId,
            workerId: lockedBackgroundWorker.id,
            version: lockedBackgroundWorker.version,
          });
          throw new ServiceValidationError(
            `Default queue configuration for task '${request.taskId}' missing on locked version '${lockedBackgroundWorker.version ?? "<unknown>"
            }'.`
          );
        }

        // Use the task's default queue name
        queueName = lockedMeta.queueName;
        lockedQueueId = lockedMeta.queueId ?? undefined;
        taskKind = lockedMeta.triggerSource;
      }
    } else {
      // Task is not locked to a specific version, use regular logic
      if (request.body.options?.lockToVersion) {
        // This should only happen if the findFirst failed, indicating the version doesn't exist
        throw new ServiceValidationError(
          `Task locked to version '${request.body.options.lockToVersion}', but no worker found with that version.`
        );
      }

      // Get queue name using the helper for non-locked case (handles provided name or finds default)
      const taskInfo = await this.getTaskQueueInfo(request);
      queueName = taskInfo.queueName;
      taskTtl = taskInfo.taskTtl;
      taskKind = taskInfo.taskKind;
    }

    // Sanitize the final determined queue name once
    const sanitizedQueueName = sanitizeQueueName(queueName);

    // Check that the queuename is not an empty string
    if (!sanitizedQueueName) {
      queueName = sanitizeQueueName(`task/${request.taskId}`); // Fallback if sanitization results in empty
    } else {
      queueName = sanitizedQueueName;
    }

    return {
      queueName,
      lockedQueueId,
      taskTtl,
      taskKind,
    };
  }

  private async getTaskQueueInfo(
    request: TriggerTaskRequest
  ): Promise<{ queueName: string; taskTtl?: string | null; taskKind?: string | undefined }> {
    const { taskId, environment, body } = request;
    const { queue } = body.options ?? {};

    // Use extractQueueName to handle double-wrapped queue objects
    const overriddenQueueName = extractQueueName(queue);

    const defaultQueueName = `task/${taskId}`;

    // Resolve the current worker's task metadata via cache (HGET on warm path,
    // BackgroundWorkerTask findFirst + cache back-fill on miss). When this hits,
    // both the queue-override + TTL caller and the default-queue caller satisfy
    // their full result without any database query.
    const meta = await this.resolveCurrentTaskMetadata(environment, taskId);

    if (overriddenQueueName) {
      // Caller already named the queue. We only need triggerSource (for taskKind)
      // and ttl (for the call site to coalesce against body.options.ttl).
      return {
        queueName: overriddenQueueName,
        taskTtl: meta?.ttl ?? undefined,
        taskKind: meta?.triggerSource,
      };
    }

    if (!meta) {
      logger.debug("Failed to get queue name: No worker or task found", {
        taskId,
        environmentId: environment.id,
      });
      return { queueName: defaultQueueName, taskTtl: undefined };
    }

    if (!meta.queueName) {
      logger.debug("Failed to get queue name: No queue found", {
        taskId,
        environmentId: environment.id,
      });
      return { queueName: defaultQueueName, taskTtl: meta.ttl, taskKind: meta.triggerSource };
    }

    return { queueName: meta.queueName, taskTtl: meta.ttl, taskKind: meta.triggerSource };
  }

  /**
   * Resolve task metadata for a locked-version trigger. Reads from the
   * `task-meta:by-worker:{workerId}` Redis hash; falls back to a single
   * BackgroundWorkerTask findFirst on miss and back-fills the cache.
   *
   * Returns null when no BackgroundWorkerTask row exists.
   */
  private async resolveLockedTaskMetadata(
    workerId: string,
    environmentId: string,
    slug: string
  ): Promise<TaskMetadataEntry | null> {
    const cached = await this.taskMetaCache.getByWorker(workerId, slug);
    if (cached) return cached;

    const row = await this.replicaPrisma.backgroundWorkerTask.findFirst({
      where: { workerId, runtimeEnvironmentId: environmentId, slug },
      select: {
        ttl: true,
        triggerSource: true,
        queue: { select: { id: true, name: true } },
      },
    });

    if (!row) return null;

    const entry: TaskMetadataEntry = {
      slug,
      ttl: row.ttl,
      triggerSource: row.triggerSource,
      queueId: row.queue?.id ?? null,
      queueName: row.queue?.name ?? "",
    };

    // Fire-and-forget back-fill — `setByWorker` upserts the single field and
    // refreshes the hash TTL. Errors are logged inside the cache and swallowed.
    void this.taskMetaCache.setByWorker(workerId, entry);

    return entry;
  }

  /**
   * Resolve task metadata for a non-locked trigger. Reads from the
   * `task-meta:env:{envId}` Redis hash; falls back to
   * findCurrentWorkerFromEnvironment + a single BackgroundWorkerTask findFirst
   * on miss and back-fills both keyspaces.
   *
   * Returns null when no current worker or task can be resolved.
   */
  private async resolveCurrentTaskMetadata(
    environment: AuthenticatedEnvironment,
    slug: string
  ): Promise<TaskMetadataEntry | null> {
    const cached = await this.taskMetaCache.getCurrent(environment.id, slug);
    if (cached) return cached;

    // Cold cache: discover the current worker for the env. Replica is fine —
    // the adjacent BackgroundWorkerTask lookup below uses `replicaPrisma` too
    // (replica lag for "just deployed" is bounded the same way for both
    // queries; reading from the writer here would only widen the window).
    const worker = await findCurrentWorkerFromEnvironment(environment, this.replicaPrisma);
    if (!worker) return null;

    const row = await this.replicaPrisma.backgroundWorkerTask.findFirst({
      where: { workerId: worker.id, runtimeEnvironmentId: environment.id, slug },
      select: {
        ttl: true,
        triggerSource: true,
        queue: { select: { id: true, name: true } },
      },
    });

    if (!row) return null;

    const entry: TaskMetadataEntry = {
      slug,
      ttl: row.ttl,
      triggerSource: row.triggerSource,
      queueId: row.queue?.id ?? null,
      queueName: row.queue?.name ?? "",
    };

    // Fire-and-forget back-fill — atomically upserts the slug into both
    // keyspaces so a subsequent locked-or-not trigger hits the cache. The
    // env-keyspace TTL is preserved (promotion owns it); the by-worker TTL
    // is refreshed (sliding window keeps active workers warm).
    void this.taskMetaCache.setByCurrentWorker(environment.id, worker.id, entry);

    return entry;
  }

  async validateQueueLimits(
    environment: AuthenticatedEnvironment,
    queueName: string,
    itemsToAdd?: number
  ): Promise<QueueValidationResult> {
    const queueSizeGuard = await guardQueueSizeLimitsForQueue(
      this.engine,
      environment,
      queueName,
      itemsToAdd
    );

    logger.debug("Queue size guard result", {
      queueSizeGuard,
      queueName,
      environment: {
        id: environment.id,
        type: environment.type,
        organization: environment.organization,
        project: environment.project,
      },
    });

    return {
      ok: queueSizeGuard.isWithinLimits,
      maximumSize: queueSizeGuard.maximumSize ?? 0,
      queueSize: queueSizeGuard.queueSize ?? 0,
    };
  }

  async getWorkerQueue(
    environment: AuthenticatedEnvironment,
    regionOverride?: string
  ): Promise<{ masterQueue: string; enableFastPath: boolean } | undefined> {
    if (environment.type === "DEVELOPMENT") {
      return { masterQueue: environment.id, enableFastPath: true };
    }

    const workerGroupService = new WorkerGroupService({
      prisma: this.prisma,
      engine: this.engine,
    });

    const [error, workerGroup] = await tryCatch(
      workerGroupService.getDefaultWorkerGroupForProject({
        projectId: environment.projectId,
        regionOverride,
      })
    );

    if (error) {
      throw new ServiceValidationError(error.message);
    }

    if (!workerGroup) {
      throw new ServiceValidationError("No worker group found");
    }

    return {
      masterQueue: workerGroup.masterQueue,
      enableFastPath: workerGroup.enableFastPath,
    };
  }
}

export function getMaximumSizeForEnvironment(environment: AuthenticatedEnvironment): number | undefined {
  if (environment.type === "DEVELOPMENT") {
    return environment.organization.maximumDevQueueSize ?? env.MAXIMUM_DEV_QUEUE_SIZE;
  } else {
    return environment.organization.maximumDeployedQueueSize ?? env.MAXIMUM_DEPLOYED_QUEUE_SIZE;
  }
}

async function guardQueueSizeLimitsForQueue(
  engine: RunEngine,
  environment: AuthenticatedEnvironment,
  queueName: string,
  itemsToAdd: number = 1
) {
  const maximumSize = getMaximumSizeForEnvironment(environment);

  if (typeof maximumSize === "undefined") {
    return { isWithinLimits: true };
  }

  const queueSize = await getCachedQueueSize(engine, environment, queueName);
  const projectedSize = queueSize + itemsToAdd;

  return {
    isWithinLimits: projectedSize <= maximumSize,
    maximumSize,
    queueSize,
  };
}

async function getCachedQueueSize(
  engine: RunEngine,
  environment: AuthenticatedEnvironment,
  queueName: string
): Promise<number> {
  if (!env.QUEUE_SIZE_CACHE_ENABLED) {
    return engine.lengthOfQueue(environment, queueName);
  }

  const cacheKey = `${environment.id}:${queueName}`;
  const result = await queueSizeCache.queueSize.swr(cacheKey, async () => {
    return engine.lengthOfQueue(environment, queueName);
  });

  return result.val ?? 0;
}
