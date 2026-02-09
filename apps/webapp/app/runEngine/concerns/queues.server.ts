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
  constructor(
    private readonly prisma: PrismaClientOrTransaction,
    private readonly engine: RunEngine
  ) { }

  async resolveQueueProperties(
    request: TriggerTaskRequest,
    lockedBackgroundWorker?: LockedBackgroundWorker
  ): Promise<QueueProperties> {
    let queueName: string;
    let lockedQueueId: string | undefined;

    // Determine queue name based on lockToVersion and provided options
    if (lockedBackgroundWorker) {
      // Task is locked to a specific worker version
      const specifiedQueueName = extractQueueName(request.body.options?.queue);
      if (specifiedQueueName) {
        // A specific queue name is provided
        const specifiedQueue = await this.prisma.taskQueue.findFirst({
          // Validate it exists for the locked worker
          where: {
            name: specifiedQueueName,
            runtimeEnvironmentId: request.environment.id,
            workers: { some: { id: lockedBackgroundWorker.id } }, // Ensure the queue is associated with any task of the locked worker
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
      } else {
        // No specific queue name provided, use the default queue for the task on the locked worker
        const lockedTask = await this.prisma.backgroundWorkerTask.findFirst({
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
      queueName = await this.getQueueName(request);
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
    };
  }

  async getQueueName(request: TriggerTaskRequest): Promise<string> {
    const { taskId, environment, body } = request;
    const { queue } = body.options ?? {};

    // Use extractQueueName to handle double-wrapped queue objects
    const queueName = extractQueueName(queue);
    if (queueName) {
      return queueName;
    }

    const defaultQueueName = `task/${taskId}`;

    // Find the current worker for the environment
    const worker = await findCurrentWorkerFromEnvironment(environment, this.prisma);

    if (!worker) {
      logger.debug("Failed to get queue name: No worker found", {
        taskId,
        environmentId: environment.id,
      });

      return defaultQueueName;
    }

    const task = await this.prisma.backgroundWorkerTask.findFirst({
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

      return defaultQueueName;
    }

    if (!task.queue) {
      console.log("Failed to get queue name: No queue found", {
        taskId,
        environmentId: environment.id,
        queueConfig: task.queueConfig,
      });

      return defaultQueueName;
    }

    return task.queue.name ?? defaultQueueName;
  }

  /**
   * Resolves queue names for batch items and groups them by queue.
   * Returns a map of queue name -> count of items going to that queue.
   */
  async resolveQueueNamesForBatchItems(
    environment: AuthenticatedEnvironment,
    items: Array<{ task: string; options?: { queue?: { name?: string } } }>
  ): Promise<Map<string, number>> {
    const queueCounts = new Map<string, number>();

    // Separate items with explicit queues from those needing lookup
    const itemsNeedingLookup: Array<{ task: string; count: number }> = [];
    const taskCounts = new Map<string, number>();

    for (const item of items) {
      const explicitQueueName = extractQueueName(item.options?.queue);

      if (explicitQueueName) {
        // Item has explicit queue - count it directly
        const sanitized = sanitizeQueueName(explicitQueueName) || `task/${item.task}`;
        queueCounts.set(sanitized, (queueCounts.get(sanitized) ?? 0) + 1);
      } else {
        // Need to look up default queue for this task - group by task
        taskCounts.set(item.task, (taskCounts.get(item.task) ?? 0) + 1);
      }
    }

    // Batch lookup default queues for all unique tasks
    if (taskCounts.size > 0) {
      const worker = await findCurrentWorkerFromEnvironment(environment, this.prisma);
      const taskSlugs = Array.from(taskCounts.keys());

      // Map task slug -> queue name
      const taskQueueMap = new Map<string, string>();

      if (worker) {
        // Single query to get all tasks with their queues
        const tasks = await this.prisma.backgroundWorkerTask.findMany({
          where: {
            workerId: worker.id,
            runtimeEnvironmentId: environment.id,
            slug: { in: taskSlugs },
          },
          include: {
            queue: true,
          },
        });

        for (const task of tasks) {
          const queueName = task.queue?.name ?? `task/${task.slug}`;
          taskQueueMap.set(task.slug, sanitizeQueueName(queueName) || `task/${task.slug}`);
        }
      }

      // Count items per queue
      for (const [taskSlug, count] of taskCounts) {
        const queueName = taskQueueMap.get(taskSlug) ?? `task/${taskSlug}`;
        queueCounts.set(queueName, (queueCounts.get(queueName) ?? 0) + count);
      }
    }

    return queueCounts;
  }

  /**
   * Validates queue limits for multiple queues at once.
   * Returns the first queue that exceeds limits, or null if all are within limits.
   */
  async validateMultipleQueueLimits(
    environment: AuthenticatedEnvironment,
    queueCounts: Map<string, number>
  ): Promise<{ ok: true } | { ok: false; queueName: string; maximumSize: number; queueSize: number }> {
    const maximumSize = getMaximumSizeForEnvironment(environment);

    logger.debug("validateMultipleQueueLimits", {
      environmentId: environment.id,
      environmentType: environment.type,
      organizationId: environment.organization.id,
      maximumDevQueueSize: environment.organization.maximumDevQueueSize,
      maximumDeployedQueueSize: environment.organization.maximumDeployedQueueSize,
      resolvedMaximumSize: maximumSize,
      queueCounts: Object.fromEntries(queueCounts),
    });

    if (typeof maximumSize === "undefined") {
      return { ok: true };
    }

    for (const [queueName, itemCount] of queueCounts) {
      const queueSize = await getCachedQueueSize(this.engine, environment, queueName);
      const projectedSize = queueSize + itemCount;

      if (projectedSize > maximumSize) {
        return {
          ok: false,
          queueName,
          maximumSize,
          queueSize,
        };
      }
    }

    return { ok: true };
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
  ): Promise<string | undefined> {
    if (environment.type === "DEVELOPMENT") {
      return environment.id;
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

    return workerGroup.masterQueue;
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
