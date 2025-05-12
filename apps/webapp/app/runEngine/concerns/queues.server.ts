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
import { EngineServiceValidationError } from "./errors";

export class DefaultQueueManager implements QueueManager {
  constructor(
    private readonly prisma: PrismaClientOrTransaction,
    private readonly engine: RunEngine
  ) {}

  async resolveQueueProperties(
    request: TriggerTaskRequest,
    lockedBackgroundWorker?: LockedBackgroundWorker
  ): Promise<QueueProperties> {
    let queueName: string;
    let lockedQueueId: string | undefined;

    // Determine queue name based on lockToVersion and provided options
    if (lockedBackgroundWorker) {
      // Task is locked to a specific worker version
      if (request.body.options?.queue?.name) {
        const specifiedQueueName = request.body.options.queue.name;
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
          throw new EngineServiceValidationError(
            `Specified queue '${specifiedQueueName}' not found or not associated with locked version '${
              lockedBackgroundWorker.version ?? "<unknown>"
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
          throw new EngineServiceValidationError(
            `Task '${request.taskId}' not found on locked version '${
              lockedBackgroundWorker.version ?? "<unknown>"
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
          throw new EngineServiceValidationError(
            `Default queue configuration for task '${request.taskId}' missing on locked version '${
              lockedBackgroundWorker.version ?? "<unknown>"
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
        throw new EngineServiceValidationError(
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

    if (queue?.name) {
      return queue.name;
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

  async validateQueueLimits(environment: AuthenticatedEnvironment): Promise<QueueValidationResult> {
    const queueSizeGuard = await guardQueueSizeLimitsForEnv(this.engine, environment);

    logger.debug("Queue size guard result", {
      queueSizeGuard,
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

  async getMasterQueue(environment: AuthenticatedEnvironment): Promise<string | undefined> {
    if (environment.type === "DEVELOPMENT") {
      return;
    }

    const workerGroupService = new WorkerGroupService({
      prisma: this.prisma,
      engine: this.engine,
    });

    const workerGroup = await workerGroupService.getDefaultWorkerGroupForProject({
      projectId: environment.projectId,
    });

    if (!workerGroup) {
      throw new EngineServiceValidationError("No worker group found");
    }

    return workerGroup.masterQueue;
  }
}

function getMaximumSizeForEnvironment(environment: AuthenticatedEnvironment): number | undefined {
  if (environment.type === "DEVELOPMENT") {
    return environment.organization.maximumDevQueueSize ?? env.MAXIMUM_DEV_QUEUE_SIZE;
  } else {
    return environment.organization.maximumDeployedQueueSize ?? env.MAXIMUM_DEPLOYED_QUEUE_SIZE;
  }
}

async function guardQueueSizeLimitsForEnv(
  engine: RunEngine,
  environment: AuthenticatedEnvironment,
  itemsToAdd: number = 1
) {
  const maximumSize = getMaximumSizeForEnvironment(environment);

  if (typeof maximumSize === "undefined") {
    return { isWithinLimits: true };
  }

  const queueSize = await engine.lengthOfEnvQueue(environment);
  const projectedSize = queueSize + itemsToAdd;

  return {
    isWithinLimits: projectedSize <= maximumSize,
    maximumSize,
    queueSize,
  };
}
