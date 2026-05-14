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

  constructor(
    private readonly prisma: PrismaClientOrTransaction,
    private readonly engine: RunEngine,
    replicaPrisma?: PrismaClientOrTransaction
  ) {
    this.replicaPrisma = replicaPrisma ?? prisma;
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
        // A specific queue name is provided, validate it exists for the locked worker
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

        // Always fetch the task so we can resolve `triggerSource` (which
        // becomes `taskKind` on annotations and replicates to ClickHouse).
        // Without this, AGENT/SCHEDULED runs triggered with
        // `lockToVersion` + a queue override would be annotated as
        // STANDARD and disappear from the run-list "Source" filter.
        // `ttl` is read from the same row but only used when the caller
        // didn't specify a per-trigger TTL.
        const lockedTask = await this.replicaPrisma.backgroundWorkerTask.findFirst({
          where: {
            workerId: lockedBackgroundWorker.id,
            runtimeEnvironmentId: request.environment.id,
            slug: request.taskId,
          },
          select: { ttl: true, triggerSource: true },
        });

        if (request.body.options?.ttl === undefined) {
          taskTtl = lockedTask?.ttl;
        }
        taskKind = lockedTask?.triggerSource;
      } else {
        // No queue override - fetch task with queue to get both default queue and TTL
        const lockedTask = await this.replicaPrisma.backgroundWorkerTask.findFirst({
          where: {
            workerId: lockedBackgroundWorker.id,
            runtimeEnvironmentId: request.environment.id,
            slug: request.taskId,
          },
          include: {
            queue: true,
          },
        });

        if (!lockedTask) {
          throw new ServiceValidationError(
            `Task '${request.taskId}' not found on locked version '${lockedBackgroundWorker.version ?? "<unknown>"
            }'.`
          );
        }

        taskTtl = lockedTask.ttl;

        if (!lockedTask.queue) {
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
        queueName = lockedTask.queue.name;
        lockedQueueId = lockedTask.queue.id;
        taskKind = lockedTask.triggerSource;
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

    // Even when the caller provides both a queue override and a
    // per-trigger TTL, we still need to fetch the task so `triggerSource`
    // (which becomes `taskKind` on annotations and replicates to
    // ClickHouse) is populated. Without it, AGENT/SCHEDULED runs hitting
    // this path get stamped as STANDARD and disappear from the
    // dashboard's `Source` filter. Mirrors the locked-worker fix above
    // — `taskTtl` is harmless in the returned value because the call
    // site coalesces `body.options.ttl ?? taskTtl`.

    // Find the current worker for the environment. Replica is fine here —
    // the adjacent `backgroundWorkerTask` lookups below already use
    // `replicaPrisma` (replica lag for "just deployed" is bounded the same
    // way for both queries; reading the worker from the writer and the
    // task from the replica would only widen the inconsistency window).
    const worker = await findCurrentWorkerFromEnvironment(environment, this.replicaPrisma);

    if (!worker) {
      logger.debug("Failed to get queue name: No worker found", {
        taskId,
        environmentId: environment.id,
      });

      return { queueName: overriddenQueueName ?? defaultQueueName, taskTtl: undefined };
    }

    // When queue is overridden, we only need TTL from the task (no queue join needed)
    if (overriddenQueueName) {
      const task = await this.replicaPrisma.backgroundWorkerTask.findFirst({
        where: {
          workerId: worker.id,
          runtimeEnvironmentId: environment.id,
          slug: taskId,
        },
        select: { ttl: true, triggerSource: true },
      });

      return { queueName: overriddenQueueName, taskTtl: task?.ttl, taskKind: task?.triggerSource };
    }

    const task = await this.replicaPrisma.backgroundWorkerTask.findFirst({
      where: {
        workerId: worker.id,
        runtimeEnvironmentId: environment.id,
        slug: taskId,
      },
      include: {
        queue: true,
      },
    });

    if (!task) {
      console.log("Failed to get queue name: No task found", {
        taskId,
        environmentId: environment.id,
      });

      return { queueName: defaultQueueName, taskTtl: undefined };
    }

    if (!task.queue) {
      console.log("Failed to get queue name: No queue found", {
        taskId,
        environmentId: environment.id,
        queueConfig: task.queueConfig,
      });

      return { queueName: defaultQueueName, taskTtl: task.ttl, taskKind: task.triggerSource };
    }

    return { queueName: task.queue.name ?? defaultQueueName, taskTtl: task.ttl, taskKind: task.triggerSource };
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
