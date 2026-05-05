import {
  BackgroundWorkerMetadata,
  BackgroundWorkerSourceFileMetadata,
  CreateBackgroundWorkerRequestBody,
  PromptResource,
  QueueManifest,
  TaskResource,
} from "@trigger.dev/core/v3";
import { BackgroundWorkerId, stringifyDuration } from "@trigger.dev/core/v3/isomorphic";
import type { BackgroundWorker, TaskQueue, TaskQueueType } from "@trigger.dev/database";
import cronstrue from "cronstrue";
import { $transaction, Prisma, PrismaClientOrTransaction } from "~/db.server";
import { sanitizeQueueName } from "~/models/taskQueue.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { syncTaskIdentifiers } from "~/services/taskIdentifierRegistry.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import {
  removeQueueConcurrencyLimits,
  updateEnvConcurrencyLimits,
  updateQueueConcurrencyLimits,
} from "../runQueue.server";
import { calculateNextBuildVersion } from "../utils/calculateNextBuildVersion";
import { clampMaxDuration } from "../utils/maxDuration";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { CheckScheduleService } from "./checkSchedule.server";
import { projectPubSub } from "./projectPubSub.server";
import { tryCatch } from "@trigger.dev/core/v3";
import { engine } from "../runEngine.server";
import { scheduleEngine } from "../scheduleEngine.server";

/**
 * Strip BackgroundWorkerMetadata down to the slice that's actually read after
 * storage. Everything else is duplicated to dedicated columns/tables
 * (BackgroundWorker.{contentHash,cliVersion,sdkVersion,runtime,runtimeVersion},
 * BackgroundWorkerTask, BackgroundWorkerFile, TaskQueue, Prompt). Today the
 * only post-write reader is changeCurrentDeployment.server.ts, which feeds
 * tasks[].schedule into syncDeclarativeSchedules. packageVersion, contentHash,
 * and tasks[].filePath are kept solely to satisfy BackgroundWorkerMetadata's
 * required fields when the column is parsed back.
 */
export function stripBackgroundWorkerMetadataForStorage(
  metadata: BackgroundWorkerMetadata
): Prisma.InputJsonValue {
  return {
    packageVersion: metadata.packageVersion,
    contentHash: metadata.contentHash,
    tasks: metadata.tasks
      .filter((t) => t.schedule)
      .map((t) => ({
        id: t.id,
        filePath: t.filePath,
        schedule: t.schedule,
      })),
  };
}

export class CreateBackgroundWorkerService extends BaseService {
  public async call(
    projectRef: string,
    environment: AuthenticatedEnvironment,
    body: CreateBackgroundWorkerRequestBody
  ): Promise<BackgroundWorker> {
    return this.traceWithEnv("call", environment, async (span) => {
      span.setAttribute("projectRef", projectRef);

      const project = await this._prisma.project.findFirstOrThrow({
        where: {
          externalRef: projectRef,
          environments: {
            some: {
              id: environment.id,
            },
          },
        },
        include: {
          backgroundWorkers: {
            where: {
              runtimeEnvironmentId: environment.id,
            },
            orderBy: {
              createdAt: "desc",
            },
            take: 1,
          },
        },
      });

      const latestBackgroundWorker = project.backgroundWorkers[0];

      if (latestBackgroundWorker?.contentHash === body.metadata.contentHash) {
        return latestBackgroundWorker;
      }

      const nextVersion = calculateNextBuildVersion(project.backgroundWorkers[0]?.version);

      logger.debug(`Creating background worker`, {
        nextVersion,
        lastVersion: project.backgroundWorkers[0]?.version,
      });

      const backgroundWorker = await this._prisma.backgroundWorker.create({
        data: {
          ...BackgroundWorkerId.generate(),
          version: nextVersion,
          runtimeEnvironmentId: environment.id,
          projectId: project.id,
          metadata: stripBackgroundWorkerMetadataForStorage(body.metadata),
          contentHash: body.metadata.contentHash,
          cliVersion: body.metadata.cliPackageVersion,
          sdkVersion: body.metadata.packageVersion,
          runtime: body.metadata.runtime,
          runtimeVersion: body.metadata.runtimeVersion,
          supportsLazyAttempts: body.supportsLazyAttempts,
          engine: body.engine,
        },
      });

      //upgrade the project to engine "V2" if it's not already
      if (project.engine === "V1" && body.engine === "V2") {
        await this._prisma.project.update({
          where: {
            id: project.id,
          },
          data: {
            engine: "V2",
          },
        });
      }

      const [filesError, tasksToBackgroundFiles] = await tryCatch(
        createBackgroundFiles(
          body.metadata.sourceFiles,
          backgroundWorker,
          environment,
          this._prisma
        )
      );

      if (filesError) {
        logger.error("Error creating background worker files", {
          error: filesError,
          backgroundWorker,
          environment,
        });

        throw new ServiceValidationError("Error creating background worker files");
      }

      const [resourcesError] = await tryCatch(
        createWorkerResources(
          body.metadata,
          backgroundWorker,
          environment,
          this._prisma,
          tasksToBackgroundFiles
        )
      );

      if (resourcesError) {
        logger.error("Error creating worker resources", {
          error: resourcesError,
          backgroundWorker,
          environment,
        });
        throw new ServiceValidationError("Error creating worker resources");
      }

      const [schedulesError] = await tryCatch(
        syncDeclarativeSchedules(body.metadata.tasks, backgroundWorker, environment, this._prisma)
      );

      if (schedulesError) {
        if (schedulesError instanceof ServiceValidationError) {
          // Customer schedule config (typically invalid cron). Surface to
          // client via the rethrow; system returns gracefully.
          logger.warn("Error syncing declarative schedules", {
            error: schedulesError.message,
            backgroundWorker,
            environment,
          });
          throw schedulesError;
        }

        // Wrapping the underlying error into a ServiceValidationError below
        // would otherwise hide it once the SDK-level filter drops SVEs; log at
        // error so the underlying cause stays visible. Mirrors the
        // waitpointCompletionPacket.server.ts pattern from dac9c83bd.
        logger.error("Error syncing declarative schedules", {
          error: schedulesError,
          backgroundWorker,
          environment,
        });

        throw new ServiceValidationError("Error syncing declarative schedules");
      }

      const [syncIdentifiersError] = await tryCatch(
        syncTaskIdentifiers(
          environment.id,
          project.id,
          backgroundWorker.id,
          body.metadata.tasks.map((t) => ({ id: t.id, triggerSource: t.triggerSource }))
        )
      );

      if (syncIdentifiersError) {
        logger.error("Error syncing task identifiers", {
          error: syncIdentifiersError,
          backgroundWorker,
          environment,
        });
      }

      const [updateConcurrencyLimitsError] = await tryCatch(
        updateEnvConcurrencyLimits(environment)
      );

      if (updateConcurrencyLimitsError) {
        logger.error("Error updating environment concurrency limits", {
          error: updateConcurrencyLimitsError,
          backgroundWorker,
          environment,
        });
      }

      const [publishError] = await tryCatch(
        projectPubSub.publish(`project:${project.id}:env:${environment.id}`, "WORKER_CREATED", {
          environmentId: environment.id,
          environmentType: environment.type,
          createdAt: backgroundWorker.createdAt,
          taskCount: body.metadata.tasks.length,
          type: "local",
        })
      );

      if (publishError) {
        logger.error("Error publishing WORKER_CREATED event", {
          error: publishError,
          backgroundWorker,
          environment,
        });
      }

      if (backgroundWorker.engine === "V2") {
        const [schedulePendingVersionsError] = await tryCatch(
          engine.scheduleEnqueueRunsForBackgroundWorker(backgroundWorker.id)
        );

        if (schedulePendingVersionsError) {
          logger.error("Error scheduling pending versions", {
            error: schedulePendingVersionsError,
          });
        }
      }

      return backgroundWorker;
    });
  }
}

export async function createWorkerResources(
  metadata: BackgroundWorkerMetadata,
  worker: BackgroundWorker,
  environment: AuthenticatedEnvironment,
  prisma: PrismaClientOrTransaction,
  tasksToBackgroundFiles?: Map<string, string>
) {
  // Create the queues
  const queues = await createWorkerQueues(metadata, worker, environment, prisma);

  // Create the tasks
  await createWorkerTasks(metadata, queues, worker, environment, prisma, tasksToBackgroundFiles);

  // Register prompts
  if (metadata.prompts && metadata.prompts.length > 0) {
    await createWorkerPrompts(metadata.prompts, worker, environment, prisma);
  }
}

async function createWorkerTasks(
  metadata: BackgroundWorkerMetadata,
  queues: Array<TaskQueue>,
  worker: BackgroundWorker,
  environment: AuthenticatedEnvironment,
  prisma: PrismaClientOrTransaction,
  tasksToBackgroundFiles?: Map<string, string>
) {
  // Create tasks in chunks of 20
  const CHUNK_SIZE = 20;
  for (let i = 0; i < metadata.tasks.length; i += CHUNK_SIZE) {
    const chunk = metadata.tasks.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map((task) =>
        createWorkerTask(task, queues, worker, environment, prisma, tasksToBackgroundFiles)
      )
    );
  }
}

async function createWorkerTask(
  task: TaskResource,
  queues: Array<TaskQueue>,
  worker: BackgroundWorker,
  environment: AuthenticatedEnvironment,
  prisma: PrismaClientOrTransaction,
  tasksToBackgroundFiles?: Map<string, string>
) {
  try {
    let queue = queues.find((queue) => queue.name === task.queue?.name);

    if (!queue) {
      // Create a TaskQueue
      queue = await createWorkerQueue(
        {
          name: task.queue?.name ?? `task/${task.id}`,
          concurrencyLimit: task.queue?.concurrencyLimit,
        },
        task.id,
        task.queue?.name ? "NAMED" : "VIRTUAL",
        worker,
        environment,
        prisma
      );
    }

    await prisma.backgroundWorkerTask.create({
      data: {
        friendlyId: generateFriendlyId("task"),
        projectId: worker.projectId,
        runtimeEnvironmentId: worker.runtimeEnvironmentId,
        workerId: worker.id,
        slug: task.id,
        description: task.description,
        filePath: task.filePath,
        exportName: task.exportName,
        retryConfig: task.retry,
        queueConfig: task.queue,
        machineConfig: task.machine,
        triggerSource: task.triggerSource === "schedule" ? "SCHEDULED" : "STANDARD",
        fileId: tasksToBackgroundFiles?.get(task.id) ?? null,
        maxDurationInSeconds: task.maxDuration ? clampMaxDuration(task.maxDuration) : null,
        ttl:
          typeof task.ttl === "number" ? stringifyDuration(task.ttl) ?? null : task.ttl ?? null,
        queueId: queue.id,
        payloadSchema: task.payloadSchema as any,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      // The error code for unique constraint violation in Prisma is P2002
      if (error.code === "P2002") {
        logger.warn("Task already exists", {
          task,
          worker,
        });
      } else {
        logger.error("Prisma Error creating background worker task", {
          error: {
            code: error.code,
            message: error.message,
          },
          task,
          worker,
        });
      }
    } else if (error instanceof Error) {
      logger.error("Error creating background worker task", {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
        task,
        worker,
      });
    } else {
      logger.error("Unknown error creating background worker task", {
        error,
        task,
        worker,
      });
    }
  }
}

async function createWorkerQueues(
  metadata: BackgroundWorkerMetadata,
  worker: BackgroundWorker,
  environment: AuthenticatedEnvironment,
  prisma: PrismaClientOrTransaction
) {
  if (!metadata.queues) {
    return [];
  }

  const CHUNK_SIZE = 20;
  const allQueues: Awaited<ReturnType<typeof createWorkerQueue>>[] = [];

  // Process queues in chunks
  for (let i = 0; i < metadata.queues.length; i += CHUNK_SIZE) {
    const chunk = metadata.queues.slice(i, i + CHUNK_SIZE);
    const queueChunk = await Promise.all(
      chunk.map(async (queue) => {
        return createWorkerQueue(queue, queue.name, "NAMED", worker, environment, prisma);
      })
    );
    allQueues.push(...queueChunk.filter(Boolean));
  }

  return allQueues;
}

async function createWorkerQueue(
  queue: QueueManifest,
  orderableName: string,
  queueType: TaskQueueType,
  worker: BackgroundWorker,
  environment: AuthenticatedEnvironment,
  prisma: PrismaClientOrTransaction
) {
  let queueName = sanitizeQueueName(queue.name);

  const baseConcurrencyLimit =
    typeof queue.concurrencyLimit === "number"
      ? Math.max(Math.min(queue.concurrencyLimit, environment.maximumConcurrencyLimit), 0)
      : queue.concurrencyLimit;

  const taskQueue = await upsertWorkerQueueRecord(
    queueName,
    baseConcurrencyLimit ?? null,
    orderableName,
    queueType,
    worker,
    prisma
  );

  const newConcurrencyLimit = taskQueue.concurrencyLimit;

  if (!taskQueue.paused) {
    if (typeof newConcurrencyLimit === "number") {
      logger.debug("createWorkerQueue: updating concurrency limit", {
        workerId: worker.id,
        taskQueue,
        orgId: environment.organizationId,
        projectId: environment.projectId,
        environmentId: environment.id,
        concurrencyLimit: newConcurrencyLimit,
      });
      await updateQueueConcurrencyLimits(environment, taskQueue.name, newConcurrencyLimit);
    } else {
      logger.debug("createWorkerQueue: removing concurrency limit", {
        workerId: worker.id,
        taskQueue,
        orgId: environment.organizationId,
        projectId: environment.projectId,
        environmentId: environment.id,
        concurrencyLimit: newConcurrencyLimit,
      });
      await removeQueueConcurrencyLimits(environment, taskQueue.name);
    }
  } else {
    logger.debug("createWorkerQueue: queue is paused, not updating concurrency limit", {
      workerId: worker.id,
      taskQueue,
      orgId: environment.organizationId,
      projectId: environment.projectId,
      environmentId: environment.id,
    });
  }

  return taskQueue;
}

async function upsertWorkerQueueRecord(
  queueName: string,
  concurrencyLimit: number | null,
  orderableName: string,
  queueType: TaskQueueType,
  worker: BackgroundWorker,
  prisma: PrismaClientOrTransaction,
  attempt: number = 0
): Promise<TaskQueue> {
  if (attempt > 3) {
    throw new Error("Failed to insert queue record");
  }

  try {
    let taskQueue = await prisma.taskQueue.findFirst({
      where: {
        runtimeEnvironmentId: worker.runtimeEnvironmentId,
        name: queueName,
      },
    });

    if (!taskQueue) {
      taskQueue = await prisma.taskQueue.create({
        data: {
          friendlyId: generateFriendlyId("queue"),
          version: "V2",
          name: queueName,
          orderableName,
          concurrencyLimit,
          runtimeEnvironmentId: worker.runtimeEnvironmentId,
          projectId: worker.projectId,
          type: queueType,
          workers: {
            connect: {
              id: worker.id,
            },
          },
        },
      });
    } else {
      const hasOverride = taskQueue.concurrencyLimitOverriddenAt !== null;

      taskQueue = await prisma.taskQueue.update({
        where: {
          id: taskQueue.id,
        },
        data: {
          workers: { connect: { id: worker.id } },
          version: "V2",
          orderableName,
          // If overridden, keep current limit and update base; otherwise update limit normally
          concurrencyLimit: hasOverride ? undefined : concurrencyLimit,
          concurrencyLimitBase: hasOverride ? concurrencyLimit : undefined,
        },
      });
    }

    return taskQueue;
  } catch (error) {
    // If the queue already exists, let's try again
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return await upsertWorkerQueueRecord(
        queueName,
        concurrencyLimit,
        orderableName,
        queueType,
        worker,
        prisma,
        attempt + 1
      );
    }
    throw error;
  }
}
//CreateDeclarativeScheduleError with a message
export class CreateDeclarativeScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreateDeclarativeScheduleError";
  }
}

export async function syncDeclarativeSchedules(
  tasks: TaskResource[],
  worker: BackgroundWorker,
  environment: AuthenticatedEnvironment,
  prisma: PrismaClientOrTransaction
) {
  const tasksWithDeclarativeSchedules = tasks.filter((task) => task.schedule);
  logger.info("Syncing declarative schedules", {
    tasksWithDeclarativeSchedules,
    environment,
  });

  const existingDeclarativeSchedules = await prisma.taskSchedule.findMany({
    where: {
      type: "DECLARATIVE",
      projectId: environment.projectId,
    },
    include: {
      instances: true,
    },
  });

  const checkSchedule = new CheckScheduleService(prisma);

  //start out by assuming they're all missing
  const missingSchedules = new Set<string>(
    existingDeclarativeSchedules.map((schedule) => schedule.id)
  );

  //create/update schedules (+ instances)
  for (const task of tasksWithDeclarativeSchedules) {
    if (task.schedule === undefined) continue;

    // Check if this schedule should be created in the current environment
    if (task.schedule.environments && task.schedule.environments.length > 0) {
      if (!task.schedule.environments.includes(environment.type)) {
        logger.debug("Skipping schedule creation due to environment filter", {
          taskId: task.id,
          environmentType: environment.type,
          allowedEnvironments: task.schedule.environments,
        });
        continue;
      }
    }

    const existingSchedule = existingDeclarativeSchedules.find(
      (schedule) =>
        schedule.taskIdentifier === task.id &&
        schedule.instances.some((instance) => instance.environmentId === environment.id)
    );

    //this throws errors if the schedule is invalid
    await checkSchedule.call(
      environment.projectId,
      {
        cron: task.schedule.cron,
        timezone: task.schedule.timezone,
        taskIdentifier: task.id,
        friendlyId: existingSchedule?.friendlyId,
      },
      [environment.id]
    );

    if (existingSchedule) {
      const schedule = await prisma.taskSchedule.update({
        where: {
          id: existingSchedule.id,
        },
        data: {
          generatorExpression: task.schedule.cron,
          generatorDescription: cronstrue.toString(task.schedule.cron),
          timezone: task.schedule.timezone,
        },
        include: {
          instances: true,
        },
      });

      missingSchedules.delete(existingSchedule.id);
      const instance = schedule.instances.at(0);
      if (instance) {
        await scheduleEngine.registerNextTaskScheduleInstance({ instanceId: instance.id });
      } else {
        throw new CreateDeclarativeScheduleError(
          `Missing instance for declarative schedule ${schedule.id}`
        );
      }
    } else {
      const newSchedule = await prisma.taskSchedule.create({
        data: {
          friendlyId: generateFriendlyId("sched"),
          projectId: environment.projectId,
          taskIdentifier: task.id,
          generatorExpression: task.schedule.cron,
          generatorDescription: cronstrue.toString(task.schedule.cron),
          timezone: task.schedule.timezone,
          type: "DECLARATIVE",
          instances: {
            create: [
              {
                environmentId: environment.id,
                projectId: environment.projectId,
              },
            ],
          },
        },
        include: {
          instances: true,
        },
      });

      const instance = newSchedule.instances.at(0);

      if (instance) {
        await scheduleEngine.registerNextTaskScheduleInstance({ instanceId: instance.id });
      } else {
        throw new CreateDeclarativeScheduleError(
          `Missing instance for declarative schedule ${newSchedule.id}`
        );
      }
    }
  }

  //Delete instances for this environment
  //Delete schedules that have no instances left
  const potentiallyDeletableSchedules = await prisma.taskSchedule.findMany({
    where: {
      id: {
        in: Array.from(missingSchedules),
      },
    },
    include: {
      instances: true,
    },
  });

  for (const schedule of potentiallyDeletableSchedules) {
    const canDeleteSchedule =
      schedule.instances.length === 0 ||
      schedule.instances.every((instance) => instance.environmentId === environment.id);

    if (canDeleteSchedule) {
      //we can delete schedules with no instances other than ones for the current environment
      await prisma.taskSchedule.delete({
        where: {
          id: schedule.id,
        },
      });
    } else {
      //otherwise we delete the instance (other environments remain untouched)
      await prisma.taskScheduleInstance.deleteMany({
        where: {
          taskScheduleId: schedule.id,
          environmentId: environment.id,
        },
      });
    }
  }
}

export async function createBackgroundFiles(
  files: Array<BackgroundWorkerSourceFileMetadata> | undefined,
  worker: BackgroundWorker,
  environment: AuthenticatedEnvironment,
  prisma: PrismaClientOrTransaction
) {
  // Maps from each taskId to the backgroundWorkerFileId
  const results = new Map<string, string>();

  if (!files) {
    return results;
  }

  for (const file of files) {
    const backgroundWorkerFile = await prisma.backgroundWorkerFile.upsert({
      where: {
        projectId_contentHash: {
          projectId: environment.projectId,
          contentHash: file.contentHash,
        },
      },
      create: {
        friendlyId: generateFriendlyId("file"),
        projectId: environment.projectId,
        contentHash: file.contentHash,
        filePath: file.filePath,
        contents: Buffer.from(file.contents),
        backgroundWorkers: {
          connect: {
            id: worker.id,
          },
        },
      },
      update: {
        backgroundWorkers: {
          connect: {
            id: worker.id,
          },
        },
      },
    });

    for (const taskId of file.taskIds) {
      results.set(taskId, backgroundWorkerFile.id);
    }
  }

  return results;
}

import { createHash } from "crypto";

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function createWorkerPrompts(
  prompts: PromptResource[],
  worker: BackgroundWorker,
  environment: AuthenticatedEnvironment,
  prisma: PrismaClientOrTransaction
) {
  for (const promptResource of prompts) {
    try {
      // Upsert the Prompt record (identity + schema)
      const prompt = await prisma.prompt.upsert({
        where: {
          projectId_runtimeEnvironmentId_slug: {
            projectId: worker.projectId,
            runtimeEnvironmentId: environment.id,
            slug: promptResource.id,
          },
        },
        create: {
          friendlyId: generateFriendlyId("prompt"),
          organizationId: environment.organizationId,
          projectId: worker.projectId,
          runtimeEnvironmentId: environment.id,
          slug: promptResource.id,
          description: promptResource.description,
          filePath: promptResource.filePath,
          exportName: promptResource.exportName,
          variableSchema: promptResource.variableSchema as any,
          defaultModel: promptResource.model,
          defaultConfig: promptResource.config as any,
        },
        update: {
          description: promptResource.description,
          filePath: promptResource.filePath,
          exportName: promptResource.exportName,
          variableSchema: promptResource.variableSchema as any,
          defaultModel: promptResource.model,
          defaultConfig: promptResource.config as any,
        },
      });

      // Compute content hash for dedup
      const contentString = promptResource.content ?? "";
      const contentHash = hashContent(contentString);

      // Find the latest version overall (for version numbering) and the latest
      // code-sourced version (for content dedup). We compare against the latest
      // code version specifically so that dashboard edits don't interfere with
      // dedup — if the code hasn't changed since the last deploy, we skip even
      // if a dashboard edit happened in between.
      const latestVersion = await prisma.promptVersion.findFirst({
        where: { promptId: prompt.id },
        orderBy: { version: "desc" },
      });

      const latestCodeVersion = await prisma.promptVersion.findFirst({
        where: { promptId: prompt.id, source: "code" },
        orderBy: { version: "desc" },
      });

      if (latestCodeVersion?.contentHash === contentHash) {
        // Code content unchanged since last deploy — skip creating a new version
        continue;
      }

      const nextVersion = (latestVersion?.version ?? 0) + 1;

      // Determine labels for the new version.
      // Deploys always move "current" to the new code version. If a dashboard
      // override exists, it sits on top via the "override" label and the API
      // serves that instead — so "current" movement is safe.
      const labels = ["latest", "current"];

      // Wrap label removal + version creation in a transaction so labels
      // aren't stripped if the create fails (e.g. concurrent deploy race).
      await $transaction(prisma, async (tx) => {
        // Remove "latest" label from all existing versions
        if (latestVersion) {
          await tx.$executeRaw`
            UPDATE "prompt_versions"
            SET "labels" = array_remove("labels", 'latest')
            WHERE "promptId" = ${prompt.id} AND 'latest' = ANY("labels")
          `;
        }

        // Remove "current" from any existing version
        await tx.$executeRaw`
          UPDATE "prompt_versions"
          SET "labels" = array_remove("labels", 'current')
          WHERE "promptId" = ${prompt.id} AND 'current' = ANY("labels")
        `;

        await tx.promptVersion.create({
          data: {
            promptId: prompt.id,
            version: nextVersion,
            textContent: contentString,
            model: promptResource.model,
            config: promptResource.config as any,
            source: "code",
            contentHash,
            labels,
            workerId: worker.id,
          },
        });
      });

      logger.debug("Registered prompt version", {
        promptSlug: promptResource.id,
        version: nextVersion,
        labels,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        logger.warn("Prompt version already exists", { prompt: promptResource.id });
      } else {
        logger.error("Error creating prompt version", {
          error: error instanceof Error ? error.message : String(error),
          prompt: promptResource.id,
        });
      }
    }
  }
}
