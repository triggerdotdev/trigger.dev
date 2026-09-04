import type {
  BackgroundWorkerMetadata,
  BackgroundWorkerSourceFileMetadata,
  CreateBackgroundWorkerRequestBody,
  FilterAst,
  PromptResource,
  QueueManifest,
  TaskResource,
  WebhookResource,
} from "@trigger.dev/core/v3";
import { FILTER_AST_VERSION, tryCatch } from "@trigger.dev/core/v3";
import { FilterParseError, parseFilter } from "@internal/webhook-engine";
import {
  BackgroundWorkerId,
  WebhookEndpointId,
  stringifyDuration,
} from "@trigger.dev/core/v3/isomorphic";
import { randomBytes } from "node:crypto";
import type { BackgroundWorker, TaskQueue, TaskQueueType } from "@trigger.dev/database";
import cronstrue from "cronstrue";
import type { PrismaClientOrTransaction, WebhookDatabase } from "~/db.server";
import { $transaction, Prisma, boundedIn, webhookPrisma } from "~/db.server";
import { sanitizeQueueName } from "~/models/taskQueue.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { syncTaskIdentifiers } from "~/services/taskIdentifierRegistry.server";
import {
  type TaskMetadataCache,
  type TaskMetadataEntry,
} from "~/services/taskMetadataCache.server";
import { taskMetadataCacheInstance } from "~/services/taskMetadataCacheInstance.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { engine } from "../runEngine.server";
import {
  removeQueueConcurrencyLimits,
  removeQueueTotalConcurrencyLimits,
  updateEnvConcurrencyLimits,
  updateQueueConcurrencyLimits,
  updateQueueTotalConcurrencyLimits,
} from "../runQueue.server";
import { scheduleEngine } from "../scheduleEngine.server";
import { normalizeScheduleWindow } from "../scheduleWindow.server";
import { calculateNextBuildVersion } from "../utils/calculateNextBuildVersion";
import { clampMaxDuration } from "../utils/maxDuration";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { CheckScheduleService } from "./checkSchedule.server";
import { projectPubSub } from "./projectPubSub.server";

import { assertNoDuplicateTaskIds } from "./duplicateTaskIds.server";
import { stripBackgroundWorkerMetadataForStorage } from "./stripBackgroundWorkerMetadataForStorage.server";

export class CreateBackgroundWorkerService extends BaseService {
  private readonly _taskMetaCache: TaskMetadataCache;

  constructor(
    prisma?: PrismaClientOrTransaction,
    replica?: PrismaClientOrTransaction,
    taskMetaCache: TaskMetadataCache = taskMetadataCacheInstance
  ) {
    super(prisma, replica);
    this._taskMetaCache = taskMetaCache;
  }

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

      const [resourcesError, workerTaskEntries] = await tryCatch(
        createWorkerResources(
          body.metadata,
          backgroundWorker,
          environment,
          this._prisma,
          tasksToBackgroundFiles
        )
      );

      if (resourcesError) {
        if (resourcesError instanceof ServiceValidationError) {
          // Customer-facing config error (e.g. duplicate task ids). Surface the
          // real message to the client via the rethrow.
          logger.warn("Error creating worker resources", {
            error: resourcesError.message,
          });
          throw resourcesError;
        }

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

      const [webhooksError] = await tryCatch(
        syncDeclarativeWebhooks(
          body.metadata.webhooks,
          backgroundWorker,
          environment,
          this._prisma,
          webhookPrisma
        )
      );
      if (webhooksError) {
        if (webhooksError instanceof ServiceValidationError) {
          logger.warn("Error syncing declarative webhooks", {
            error: webhooksError.message,
            backgroundWorker,
            environment,
          });
          throw webhooksError;
        }

        logger.error("Error syncing declarative webhooks", {
          error: webhooksError,
          backgroundWorker,
          environment,
        });

        throw new ServiceValidationError("Error syncing declarative webhooks");
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

      // Populate task metadata cache. DEV workers are always "current" because
      // `findCurrentWorkerFromEnvironment` resolves DEV current as the latest
      // worker by createdAt. Non-DEV (deploy-built) workers are not promoted
      // here — promotion writes the `:env:` keyspace later in
      // changeCurrentDeployment / createDeploymentBackgroundWorkerV3.
      // Cache calls log+swallow internally, so a Redis blip can't break
      // anything else here. Empty `workerTaskEntries` is intentional — the
      // populate methods clear stale hashes for zero-task deploys.
      if (workerTaskEntries) {
        if (environment.type === "DEVELOPMENT") {
          await this._taskMetaCache.populateByCurrentWorker(
            environment.id,
            backgroundWorker.id,
            workerTaskEntries
          );
        } else {
          await this._taskMetaCache.populateByWorker(backgroundWorker.id, workerTaskEntries);
        }
      }

      const [updateConcurrencyLimitsError] = await tryCatch(
        updateEnvConcurrencyLimits(environment, undefined, this._prisma)
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
): Promise<TaskMetadataEntry[]> {
  // Defense-in-depth against two tasks sharing an id (across all task types,
  // e.g. a schedule and a regular task). Note: the CLI's resource catalog keys
  // tasks by id and overwrites collisions, so duplicates are normally already
  // collapsed before reaching here — this guards against any client that sends
  // an un-deduplicated task list.
  assertNoDuplicateTaskIds(metadata.tasks);

  // Create the queues
  const queues = await createWorkerQueues(metadata, worker, environment, prisma);

  // Create the tasks
  const taskEntries = await createWorkerTasks(
    metadata,
    queues,
    worker,
    environment,
    prisma,
    tasksToBackgroundFiles
  );

  // Register prompts
  if (metadata.prompts && metadata.prompts.length > 0) {
    await createWorkerPrompts(metadata.prompts, worker, environment, prisma);
  }

  return taskEntries;
}

async function createWorkerTasks(
  metadata: BackgroundWorkerMetadata,
  queues: Array<TaskQueue>,
  worker: BackgroundWorker,
  environment: AuthenticatedEnvironment,
  prisma: PrismaClientOrTransaction,
  tasksToBackgroundFiles?: Map<string, string>
): Promise<TaskMetadataEntry[]> {
  // Create tasks in chunks of 20
  const CHUNK_SIZE = 20;
  const entries: TaskMetadataEntry[] = [];
  for (let i = 0; i < metadata.tasks.length; i += CHUNK_SIZE) {
    const chunk = metadata.tasks.slice(i, i + CHUNK_SIZE);
    const chunkEntries = await Promise.all(
      chunk.map((task) =>
        createWorkerTask(task, queues, worker, environment, prisma, tasksToBackgroundFiles)
      )
    );
    for (const entry of chunkEntries) {
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

async function createWorkerTask(
  task: TaskResource,
  queues: Array<TaskQueue>,
  worker: BackgroundWorker,
  environment: AuthenticatedEnvironment,
  prisma: PrismaClientOrTransaction,
  tasksToBackgroundFiles?: Map<string, string>
): Promise<TaskMetadataEntry | null> {
  // Hoisted so the P2002 catch branch can return the same entry shape.
  let queue: TaskQueue | undefined;
  let resolvedTriggerSource: "SCHEDULED" | "AGENT" | "WEBHOOK" | "STANDARD" | undefined;
  let resolvedTtl: string | null | undefined;

  try {
    queue = queues.find((queue) => queue.name === task.queue?.name);

    if (!queue) {
      // Create a TaskQueue
      queue = await createWorkerQueue(
        {
          name: task.queue?.name ?? `task/${task.id}`,
          concurrencyLimit: task.queue?.concurrencyLimit,
          combinedConcurrencyLimit: task.queue?.combinedConcurrencyLimit,
        },
        task.queue?.name ?? task.id,
        task.queue?.name ? "NAMED" : "VIRTUAL",
        worker,
        environment,
        prisma
      );
    }

    resolvedTriggerSource =
      task.triggerSource === "schedule"
        ? ("SCHEDULED" as const)
        : task.triggerSource === "agent"
          ? ("AGENT" as const)
          : task.triggerSource === "webhook"
            ? ("WEBHOOK" as const)
            : ("STANDARD" as const);

    resolvedTtl =
      typeof task.ttl === "number" ? (stringifyDuration(task.ttl) ?? null) : (task.ttl ?? null);

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
        gates: task.gates,
        machineConfig: task.machine,
        triggerSource: resolvedTriggerSource,
        config: task.agentConfig ? (task.agentConfig as any) : undefined,
        fileId: tasksToBackgroundFiles?.get(task.id) ?? null,
        maxDurationInSeconds: task.maxDuration ? clampMaxDuration(task.maxDuration) : null,
        ttl: resolvedTtl,
        queueId: queue.id,
        payloadSchema: task.payloadSchema as any,
      },
    });

    return {
      slug: task.id,
      ttl: resolvedTtl,
      triggerSource: resolvedTriggerSource,
      queueId: queue.id,
      queueName: queue.name,
      gates: task.gates ?? null,
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      // The error code for unique constraint violation in Prisma is P2002
      if (error.code === "P2002") {
        // Retry landing after the first attempt's row was already written.
        const existing = await prisma.backgroundWorkerTask.findFirst({
          where: { workerId: worker.id, slug: task.id },
          select: { id: true },
        });

        logger.warn("Attempted to recreate background worker task", {
          task,
          worker,
        });

        if (existing && queue && resolvedTriggerSource && resolvedTtl !== undefined) {
          return {
            slug: task.id,
            ttl: resolvedTtl,
            triggerSource: resolvedTriggerSource,
            queueId: queue.id,
            queueName: queue.name,
            gates: task.gates ?? null,
          };
        }
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
    return null;
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
    queue.combinedConcurrencyLimit ?? null,
    orderableName,
    queueType,
    worker,
    prisma
  );

  const newConcurrencyLimit = taskQueue.concurrencyLimit;

  /**
   * The total limit key is separate from the per-queue limit key that pause zeroes,
   * so it is safe to sync it regardless of the paused state. The engine clamps it
   * to the environment limit at read time, so the raw declared value is stored.
   */
  if (typeof taskQueue.totalConcurrencyLimit === "number") {
    await updateQueueTotalConcurrencyLimits(
      environment,
      taskQueue.name,
      taskQueue.totalConcurrencyLimit
    );
  } else {
    await removeQueueTotalConcurrencyLimits(environment, taskQueue.name);
  }

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
  totalConcurrencyLimit: number | null,
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
          totalConcurrencyLimit,
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
          totalConcurrencyLimit,
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
        totalConcurrencyLimit,
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

// TODO: centralize (the P2 dynamic webhooks.create() API will also mint opaqueIds).
function generateOpaqueId(): string {
  return randomBytes(16).toString("base64url");
}

export async function syncDeclarativeWebhooks(
  webhooks: WebhookResource[] | undefined,
  worker: BackgroundWorker,
  environment: AuthenticatedEnvironment,
  prisma: PrismaClientOrTransaction,
  // Endpoint rows live on the webhook DB; the task-existence check below stays on the main client.
  webhookPrisma: WebhookDatabase
) {
  if (webhooks === undefined) return;

  const existing = await webhookPrisma.webhookEndpoint.findMany({
    where: {
      runtimeEnvironmentId: environment.id,
      endpointTenantId: "",
      endpointExternalRef: "",
    },
  });
  const missing = new Set(existing.map((e) => e.handlerWebhookId));

  for (const wh of webhooks) {
    // Both routing targets resolve to a task: a fan-out webhook to its own task, a session webhook to
    // the claiming agent. Validate the target exists in this worker so a bad route fails at sync.
    const targetTaskSlug =
      wh.routingTarget.type === "task" ? wh.routingTarget.taskId : wh.routingTarget.taskIdentifier;
    const taskExists = await prisma.backgroundWorkerTask.findFirst({
      where: { workerId: worker.id, slug: targetTaskSlug },
      select: { id: true },
    });
    if (!taskExists) {
      throw new ServiceValidationError(
        `Webhook "${wh.id}" routes to unknown task "${targetTaskSlug}"`
      );
    }

    missing.delete(wh.id);

    if (
      "config" in wh.verifierArtifact &&
      wh.verifierArtifact.config.scheme === "url-secret" &&
      wh.verifierArtifact.config.placement === "path"
    ) {
      throw new ServiceValidationError(
        `Webhook "${wh.id}" uses url-secret verification with path placement, which cannot be verified on the hosted ingress URL. Use query placement or a header-based scheme.`
      );
    }

    // Compile `filter` into a FilterAst, once here at sync. A bad filter fails the deploy with a clear
    // message rather than surfacing at ingest. Re-deploying without a filter nulls the columns.
    let filterNode: FilterAst | undefined;
    if (wh.filter) {
      try {
        filterNode = parseFilter(wh.filter);
      } catch (error) {
        if (error instanceof FilterParseError) {
          throw new ServiceValidationError(
            `Webhook "${wh.id}" has an invalid filter: ${error.message}`
          );
        }
        throw error;
      }
    }
    const filterData = {
      filter: wh.filter ?? null,
      filterAst: filterNode ? (filterNode as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      filterAstVersion: filterNode ? FILTER_AST_VERSION : null,
    };

    // Validate a session target's startOn like the route filter: a bad predicate fails the deploy, not ingest.
    if (wh.routingTarget.type === "session" && wh.routingTarget.startOn) {
      try {
        parseFilter(wh.routingTarget.startOn);
      } catch (error) {
        if (error instanceof FilterParseError) {
          throw new ServiceValidationError(
            `Webhook "${wh.id}" has an invalid startOn: ${error.message}`
          );
        }
        throw error;
      }
    }

    const found = existing.find((e) => e.handlerWebhookId === wh.id);
    if (found) {
      await webhookPrisma.webhookEndpoint.update({
        where: { id: found.id },
        data: {
          source: wh.source,
          routingTarget: wh.routingTarget as unknown as Prisma.InputJsonValue,
          verifierArtifact: wh.verifierArtifact as unknown as Prisma.InputJsonValue,
          secretProvisioning: wh.secretProvisioning ?? "either",
          metadata: (wh.metadata ?? {}) as unknown as Prisma.InputJsonValue,
          ...(found.manuallyDeactivatedAt === null ? { status: "ACTIVE" as const } : {}),
          ...filterData,
        },
      });
    } else {
      const { id, friendlyId } = WebhookEndpointId.generate();
      await webhookPrisma.webhookEndpoint.create({
        data: {
          id,
          friendlyId,
          opaqueId: generateOpaqueId(), // CSPRNG, NOT a friendlyId
          organizationId: environment.organizationId,
          projectId: environment.projectId,
          runtimeEnvironmentId: environment.id,
          environmentType: environment.type,
          endpointTenantId: "",
          endpointExternalRef: "",
          source: wh.source,
          handlerWebhookId: wh.id,
          routingTarget: wh.routingTarget as unknown as Prisma.InputJsonValue,
          verifierArtifact: wh.verifierArtifact as unknown as Prisma.InputJsonValue,
          secretProvisioning: wh.secretProvisioning ?? "either",
          metadata: (wh.metadata ?? {}) as unknown as Prisma.InputJsonValue,
          status: "ACTIVE",
          ...filterData,
        },
      });
    }
  }

  if (missing.size > 0) {
    await webhookPrisma.webhookEndpoint.updateMany({
      where: {
        runtimeEnvironmentId: environment.id,
        endpointTenantId: "",
        endpointExternalRef: "",
        handlerWebhookId: { in: boundedIn(Array.from(missing)) },
      },
      data: { status: "INACTIVE" },
    });
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
      instances: {
        some: {
          environmentId: environment.id,
        },
      },
    },
    select: {
      id: true,
      friendlyId: true,
      taskIdentifier: true,
      generatorExpression: true,
      timezone: true,
      windowDurationSeconds: true,
      windowPercentage: true,
      instances: {
        select: {
          environmentId: true,
        },
      },
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
        window: task.schedule.window,
      },
      [environment.id]
    );

    if (existingSchedule) {
      const normalizedWindow = normalizeScheduleWindow(task.schedule.window);
      const timingChanged =
        existingSchedule.generatorExpression !== task.schedule.cron ||
        existingSchedule.timezone !== task.schedule.timezone ||
        existingSchedule.windowDurationSeconds !== normalizedWindow.windowDurationSeconds ||
        existingSchedule.windowPercentage !== normalizedWindow.windowPercentage;
      const schedule = await prisma.taskSchedule.update({
        where: {
          id: existingSchedule.id,
        },
        data: {
          generatorExpression: task.schedule.cron,
          generatorDescription: cronstrue.toString(task.schedule.cron),
          timezone: task.schedule.timezone,
          ...normalizedWindow,
        },
        include: {
          instances: true,
        },
      });

      missingSchedules.delete(existingSchedule.id);
      const instance = schedule.instances.at(0);
      if (instance) {
        await scheduleEngine.registerNextTaskScheduleInstance({
          instanceId: instance.id,
          preserveExistingJob: !timingChanged,
        });
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
          ...normalizeScheduleWindow(task.schedule.window),
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
  const potentiallyDeletableSchedules = existingDeclarativeSchedules.filter((schedule) =>
    missingSchedules.has(schedule.id)
  );

  const scheduleIdsToDelete: string[] = [];
  const scheduleIdsToDetachFromEnvironment: string[] = [];

  for (const schedule of potentiallyDeletableSchedules) {
    const canDeleteSchedule =
      schedule.instances.length === 0 ||
      schedule.instances.every((instance) => instance.environmentId === environment.id);

    if (canDeleteSchedule) {
      scheduleIdsToDelete.push(schedule.id);
    } else if (schedule.instances.some((instance) => instance.environmentId === environment.id)) {
      scheduleIdsToDetachFromEnvironment.push(schedule.id);
    }
  }

  if (scheduleIdsToDelete.length > 0) {
    await prisma.taskSchedule.deleteMany({
      where: {
        id: {
          in: boundedIn(scheduleIdsToDelete),
        },
      },
    });
  }

  if (scheduleIdsToDetachFromEnvironment.length > 0) {
    await prisma.taskScheduleInstance.deleteMany({
      where: {
        taskScheduleId: {
          in: boundedIn(scheduleIdsToDetachFromEnvironment),
        },
        environmentId: environment.id,
      },
    });
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

      // Compute the version-definition hash for dedup. Includes the model and
      // config, not just the prompt text, so changing a code prompt's model or
      // config creates a new version — otherwise a model-only change is silently
      // skipped and the old model keeps serving.
      const contentString = promptResource.content ?? "";
      const contentHash = hashContent(
        JSON.stringify({
          content: contentString,
          model: promptResource.model ?? null,
          config: promptResource.config ?? null,
        })
      );

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
        // Code definition (text + model + config) unchanged since last deploy —
        // skip creating a new version.
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
