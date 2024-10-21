import { Worker, type WorkerConcurrencyOptions } from "@internal/redis-worker";
import { Attributes, Span, SpanKind, trace, Tracer } from "@opentelemetry/api";
import { Logger } from "@trigger.dev/core/logger";
import {
  MachinePreset,
  MachinePresetName,
  parsePacket,
  QueueOptions,
  sanitizeError,
  TaskRunExecution,
  TaskRunExecutionResult,
  TaskRunInternalError,
} from "@trigger.dev/core/v3";
import {
  generateFriendlyId,
  getMaxDuration,
  parseNaturalLanguageDuration,
  sanitizeQueueName,
} from "@trigger.dev/core/v3/apps";
import {
  $transaction,
  Prisma,
  PrismaClient,
  PrismaClientOrTransaction,
  TaskRun,
  TaskRunExecutionSnapshot,
  TaskRunExecutionStatus,
  TaskRunStatus,
  Waitpoint,
} from "@trigger.dev/database";
import assertNever from "assert-never";
import { Redis, type RedisOptions } from "ioredis";
import { nanoid } from "nanoid";
import { z } from "zod";
import { RunQueue } from "../run-queue";
import { SimpleWeightedChoiceStrategy } from "../run-queue/simpleWeightedPriorityStrategy";
import { MinimalAuthenticatedEnvironment } from "../shared";
import { MAX_TASK_RUN_ATTEMPTS } from "./consts";
import { getRunWithBackgroundWorkerTasks } from "./db/worker";
import { RunLocker } from "./locking";
import { machinePresetFromConfig } from "./machinePresets";
import { CreatedAttemptMessage, RunExecutionData } from "./messages";
import { isDequeueableExecutionStatus, isExecuting } from "./statuses";

type Options = {
  redis: RedisOptions;
  prisma: PrismaClient;
  worker: WorkerConcurrencyOptions & {
    pollIntervalMs?: number;
  };
  machines: {
    defaultMachine: MachinePresetName;
    machines: Record<string, MachinePreset>;
    baseCostInCents: number;
  };
  tracer: Tracer;
};

type TriggerParams = {
  friendlyId: string;
  number: number;
  environment: MinimalAuthenticatedEnvironment;
  idempotencyKey?: string;
  taskIdentifier: string;
  payload: string;
  payloadType: string;
  context: any;
  traceContext: Record<string, string | undefined>;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  lockedToVersionId?: string;
  concurrencyKey?: string;
  masterQueue: string;
  queueName: string;
  queue?: QueueOptions;
  isTest: boolean;
  delayUntil?: Date;
  queuedAt?: Date;
  maxAttempts?: number;
  ttl?: string;
  tags: string[];
  parentTaskRunId?: string;
  rootTaskRunId?: string;
  batchId?: string;
  resumeParentOnCompletion?: boolean;
  depth?: number;
  metadata?: string;
  metadataType?: string;
  seedMetadata?: string;
  seedMetadataType?: string;
};

const workerCatalog = {
  waitpointCompleteDateTime: {
    schema: z.object({
      waitpointId: z.string(),
    }),
    visibilityTimeoutMs: 5000,
  },
  heartbeatSnapshot: {
    schema: z.object({
      runId: z.string(),
      snapshotId: z.string(),
    }),
    visibilityTimeoutMs: 5000,
  },
  expireRun: {
    schema: z.object({
      runId: z.string(),
    }),
    visibilityTimeoutMs: 5000,
  },
};

type EngineWorker = Worker<typeof workerCatalog>;

export class RunEngine {
  private redis: Redis;
  private prisma: PrismaClient;
  private runLock: RunLocker;
  runQueue: RunQueue;
  private worker: EngineWorker;
  private logger = new Logger("RunEngine", "debug");
  private tracer: Tracer;

  constructor(private readonly options: Options) {
    this.prisma = options.prisma;
    this.redis = new Redis(options.redis);
    this.runLock = new RunLocker({ redis: this.redis });

    this.runQueue = new RunQueue({
      name: "rq",
      tracer: trace.getTracer("rq"),
      queuePriorityStrategy: new SimpleWeightedChoiceStrategy({ queueSelectionCount: 36 }),
      envQueuePriorityStrategy: new SimpleWeightedChoiceStrategy({ queueSelectionCount: 12 }),
      workers: 1,
      defaultEnvConcurrency: 10,
      enableRebalancing: false,
      logger: new Logger("RunQueue", "warn"),
      redis: options.redis,
    });

    this.worker = new Worker({
      name: "runengineworker",
      redisOptions: options.redis,
      catalog: workerCatalog,
      concurrency: options.worker,
      pollIntervalMs: options.worker.pollIntervalMs,
      logger: new Logger("RunEngineWorker", "debug"),
      jobs: {
        waitpointCompleteDateTime: async ({ payload }) => {
          await this.completeWaitpoint({ id: payload.waitpointId });
        },
        heartbeatSnapshot: async ({ payload }) => {
          await this.#handleStalledSnapshot(payload);
        },
        expireRun: async ({ payload }) => {
          await this.expire({ runId: payload.runId });
        },
      },
    });

    this.tracer = options.tracer;
  }

  //MARK: - Run functions

  /** "Triggers" one run. */
  async trigger(
    {
      friendlyId,
      number,
      environment,
      idempotencyKey,
      taskIdentifier,
      payload,
      payloadType,
      context,
      traceContext,
      traceId,
      spanId,
      parentSpanId,
      lockedToVersionId,
      concurrencyKey,
      masterQueue,
      queueName,
      queue,
      isTest,
      delayUntil,
      queuedAt,
      maxAttempts,
      ttl,
      tags,
      parentTaskRunId,
      rootTaskRunId,
      batchId,
      resumeParentOnCompletion,
      depth,
      metadata,
      metadataType,
      seedMetadata,
      seedMetadataType,
    }: TriggerParams,
    tx?: PrismaClientOrTransaction
  ) {
    const prisma = tx ?? this.prisma;

    return this.#trace(
      "createRunAttempt",
      {
        friendlyId,
        environmentId: environment.id,
        projectId: environment.project.id,
        taskIdentifier,
      },
      async (span) => {
        const status = delayUntil ? "DELAYED" : "PENDING";

        //create run
        const taskRun = await prisma.taskRun.create({
          data: {
            status,
            number,
            friendlyId,
            runtimeEnvironmentId: environment.id,
            projectId: environment.project.id,
            idempotencyKey,
            taskIdentifier,
            payload,
            payloadType,
            context,
            traceContext,
            traceId,
            spanId,
            parentSpanId,
            lockedToVersionId,
            concurrencyKey,
            queue: queueName,
            masterQueue,
            isTest,
            delayUntil,
            queuedAt,
            maxAttempts,
            ttl,
            tags:
              tags.length === 0
                ? undefined
                : {
                    connect: tags.map((id) => ({ id })),
                  },
            parentTaskRunId,
            rootTaskRunId,
            batchId,
            resumeParentOnCompletion,
            depth,
            metadata,
            metadataType,
            seedMetadata,
            seedMetadataType,
            executionSnapshots: {
              create: {
                engine: "V2",
                executionStatus: "RUN_CREATED",
                description: "Run was created",
                runStatus: status,
              },
            },
          },
        });

        span.setAttribute("runId", taskRun.id);

        await this.runLock.lock([taskRun.id], 5000, async (signal) => {
          //create associated waitpoint (this completes when the run completes)
          const associatedWaitpoint = await this.#createRunAssociatedWaitpoint(prisma, {
            projectId: environment.project.id,
            completedByTaskRunId: taskRun.id,
          });

          //triggerAndWait or batchTriggerAndWait
          if (resumeParentOnCompletion && parentTaskRunId) {
            //this will block the parent run from continuing until this waitpoint is completed (and removed)
            await this.#blockRunWithWaitpoint(prisma, {
              orgId: environment.organization.id,
              runId: parentTaskRunId,
              waitpoint: associatedWaitpoint,
            });
          }

          //Make sure lock extension succeeded
          signal.throwIfAborted();

          if (queue) {
            const concurrencyLimit =
              typeof queue.concurrencyLimit === "number"
                ? Math.max(0, queue.concurrencyLimit)
                : undefined;

            let taskQueue = await prisma.taskQueue.findFirst({
              where: {
                runtimeEnvironmentId: environment.id,
                name: queueName,
              },
            });

            if (taskQueue) {
              taskQueue = await prisma.taskQueue.update({
                where: {
                  id: taskQueue.id,
                },
                data: {
                  concurrencyLimit,
                  rateLimit: queue.rateLimit,
                },
              });
            } else {
              taskQueue = await prisma.taskQueue.create({
                data: {
                  friendlyId: generateFriendlyId("queue"),
                  name: queueName,
                  concurrencyLimit,
                  runtimeEnvironmentId: environment.id,
                  projectId: environment.project.id,
                  rateLimit: queue.rateLimit,
                  type: "NAMED",
                },
              });
            }

            if (typeof taskQueue.concurrencyLimit === "number") {
              await this.runQueue.updateQueueConcurrencyLimits(
                environment,
                taskQueue.name,
                taskQueue.concurrencyLimit
              );
            } else {
              await this.runQueue.removeQueueConcurrencyLimits(environment, taskQueue.name);
            }
          }

          if (taskRun.delayUntil) {
            const delayWaitpoint = await this.#createDateTimeWaitpoint(prisma, {
              projectId: environment.project.id,
              completedAfter: taskRun.delayUntil,
            });

            await prisma.taskRunWaitpoint.create({
              data: {
                taskRunId: taskRun.id,
                waitpointId: delayWaitpoint.id,
                projectId: delayWaitpoint.projectId,
              },
            });
          }

          if (!taskRun.delayUntil && taskRun.ttl) {
            const expireAt = parseNaturalLanguageDuration(taskRun.ttl);

            if (expireAt) {
              await this.worker.enqueue({
                id: `expireRun:${taskRun.id}`,
                job: "expireRun",
                payload: { runId: taskRun.id },
              });
            }
          }

          //Make sure lock extension succeeded
          signal.throwIfAborted();

          //enqueue the run if it's not delayed
          if (!taskRun.delayUntil) {
            await this.#enqueueRun(taskRun, environment, prisma);
          }
        });

        //todo release parent concurrency (for the project, task, and environment, but not for the queue?)
        //todo if this has been triggered with triggerAndWait or batchTriggerAndWait

        return taskRun;
      }
    );
  }

  /** Triggers multiple runs.
   * This doesn't start execution, but it will create a batch and schedule them for execution.
   */
  async batchTrigger() {}

  /**
   * Gets a fairly selected run from the specified master queue, returning the information required to run it.
   * @param consumerId: The consumer that is pulling, allows multiple consumers to pull from the same queue
   * @param masterQueue: The shared queue to pull from, can be an individual environment (for dev)
   * @returns
   */
  async dequeueFromMasterQueue({
    consumerId,
    masterQueue,
    tx,
  }: {
    consumerId: string;
    masterQueue: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<null | CreatedAttemptMessage> {
    const prisma = tx ?? this.prisma;
    return this.#trace("createRunAttempt", { consumerId, masterQueue }, async (span) => {
      //gets a fair run from this shared queue
      const message = await this.runQueue.dequeueMessageInSharedQueue(consumerId, masterQueue);
      if (!message) {
        return null;
      }

      const orgId = message.message.orgId;
      const runId = message.messageId;

      span.setAttribute("runId", runId);

      //lock the run so nothing else can modify it
      return this.runLock.lock([runId], 5000, async (signal) => {
        const snapshot = await this.#getLatestExecutionSnapshot(prisma, runId);
        if (!snapshot) {
          throw new Error(
            `RunEngine.dequeueFromMasterQueue(): No snapshot found for run: ${runId}`
          );
        }

        if (!isDequeueableExecutionStatus(snapshot.executionStatus)) {
          //todo is there a way to recover this, so the run can be retried?
          await this.#systemFailure({
            runId,
            error: {
              type: "INTERNAL_ERROR",
              code: "TASK_DEQUEUED_INVALID_STATE",
              message: `Task was in the ${snapshot.executionStatus} state when it was dequeued for execution.`,
            },
            tx: prisma,
          });
          this.logger.error(
            `RunEngine.dequeueFromMasterQueue(): Run is not in a valid state to be dequeued: ${runId}\n ${snapshot.id}:${snapshot.executionStatus}`
          );
          return null;
        }

        const result = await getRunWithBackgroundWorkerTasks(prisma, runId);

        if (!result.success) {
          switch (result.code) {
            case "NO_RUN": {
              //this should not happen, the run is unrecoverable so we'll ack it
              this.logger.error("RunEngine.dequeueFromMasterQueue(): No run found", {
                runId,
                latestSnapshot: snapshot.id,
              });
              await this.runQueue.acknowledgeMessage(orgId, runId);
              return null;
            }
            case "NO_WORKER":
            case "TASK_NEVER_REGISTERED":
            case "TASK_NOT_IN_LATEST": {
              this.logger.warn(`RunEngine.dequeueFromMasterQueue(): ${result.code}`, {
                runId,
                latestSnapshot: snapshot.id,
                result,
              });

              if (result.run.runtimeEnvironment.type === "DEVELOPMENT") {
                //requeue for 10s in the future, so we can try again
                //todo when do we stop doing this, the run.ttl should deal with this.
                await this.runQueue.nackMessage(
                  orgId,
                  runId,
                  new Date(Date.now() + 10_000).getTime()
                );
              } else {
                //not deployed yet, so we'll wait for the deploy
                await this.#waitingForDeploy({
                  runId,
                  tx: prisma,
                });
                //we ack because when it's deployed it will be requeued
                await this.runQueue.acknowledgeMessage(orgId, runId);
              }

              return null;
            }
          }
        }

        //check for a valid deployment if it's not a development environment
        if (result.run.runtimeEnvironment.type !== "DEVELOPMENT") {
          if (!result.deployment || !result.deployment.imageReference) {
            this.logger.warn("RunEngine.dequeueFromMasterQueue(): No deployment found", {
              runId,
              latestSnapshot: snapshot.id,
              result,
            });
            //not deployed yet, so we'll wait for the deploy
            await this.#waitingForDeploy({
              runId,
              tx: prisma,
            });
            //we ack because when it's deployed it will be requeued
            await this.runQueue.acknowledgeMessage(orgId, runId);
            return null;
          }
        }

        const machinePreset = machinePresetFromConfig({
          machines: this.options.machines.machines,
          defaultMachine: this.options.machines.defaultMachine,
          config: result.task.machineConfig ?? {},
        });

        //update the run
        const lockedTaskRun = await prisma.taskRun.update({
          where: {
            id: runId,
          },
          data: {
            lockedAt: new Date(),
            lockedById: result.task.id,
            lockedToVersionId: result.worker.id,
            startedAt: result.run.startedAt ?? new Date(),
            baseCostInCents: this.options.machines.baseCostInCents,
            machinePreset: machinePreset.name,
            maxDurationInSeconds: getMaxDuration(
              result.run.maxDurationInSeconds,
              result.task.maxDurationInSeconds
            ),
          },
          include: {
            runtimeEnvironment: true,
            attempts: {
              take: 1,
              orderBy: { number: "desc" },
            },
            tags: true,
          },
        });

        if (!lockedTaskRun) {
          this.logger.error("RunEngine.dequeueFromMasterQueue(): Failed to lock task run", {
            taskRun: result.run.id,
            taskIdentifier: result.run.taskIdentifier,
            deployment: result.deployment?.id,
            worker: result.worker.id,
            task: result.task.id,
            runId,
          });

          await this.runQueue.acknowledgeMessage(orgId, runId);
          return null;
        }

        const queue = await prisma.taskQueue.findUnique({
          where: {
            runtimeEnvironmentId_name: {
              runtimeEnvironmentId: lockedTaskRun.runtimeEnvironmentId,
              name: sanitizeQueueName(lockedTaskRun.queue),
            },
          },
        });

        if (!queue) {
          this.logger.debug(
            "RunEngine.dequeueFromMasterQueue(): queue not found, so nacking message",
            {
              queueMessage: message,
              taskRunQueue: lockedTaskRun.queue,
              runtimeEnvironmentId: lockedTaskRun.runtimeEnvironmentId,
            }
          );

          //try again in 1 second
          await this.runQueue.nackMessage(orgId, runId, new Date(Date.now() + 1000).getTime());
          return null;
        }

        const currentAttemptNumber = lockedTaskRun.attempts.at(0)?.number ?? 0;
        const nextAttemptNumber = currentAttemptNumber + 1;

        //todo figure out if it's a continuation or a new run
        const isNewRun = true;

        const newSnapshot = await this.#createExecutionSnapshot(prisma, {
          run: {
            id: runId,
            status: snapshot.runStatus,
          },
          snapshot: {
            executionStatus: "PENDING_EXECUTING",
            description: "Run was dequeued for execution",
          },
          checkpointId: snapshot.checkpointId ?? undefined,
        });

        return {
          action: "SCHEDULE_RUN",
          payload: {
            version: "1",
            execution: {
              id: newSnapshot.id,
              status: "PENDING_EXECUTING",
            },
            image: result.deployment?.imageReference ?? undefined,
            checkpoint: newSnapshot.checkpoint ?? undefined,
            backgroundWorker: {
              id: result.worker.id,
              version: result.worker.version,
            },
            run: {
              id: lockedTaskRun.id,
              friendlyId: lockedTaskRun.friendlyId,
              isTest: lockedTaskRun.isTest,
              machine: machinePreset,
              attemptNumber: nextAttemptNumber,
              masterQueue: lockedTaskRun.masterQueue,
              traceContext: lockedTaskRun.traceContext as Record<string, unknown>,
            },
            environment: {
              id: lockedTaskRun.runtimeEnvironment.id,
              type: lockedTaskRun.runtimeEnvironment.type,
            },
            organization: {
              id: orgId,
            },
            project: {
              id: lockedTaskRun.projectId,
            },
          },
        };
      });
    });
  }

  async startRunAttempt({
    runId,
    snapshotId,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    tx?: PrismaClientOrTransaction;
  }) {
    const prisma = tx ?? this.prisma;

    return this.#trace("createRunAttempt", { runId, snapshotId }, async (span) => {
      return this.runLock.lock([runId], 5000, async (signal) => {
        const latestSnapshot = await this.#getLatestExecutionSnapshot(prisma, runId);
        if (!latestSnapshot) {
          await this.#systemFailure({
            runId,
            error: {
              type: "INTERNAL_ERROR",
              code: "TASK_HAS_N0_EXECUTION_SNAPSHOT",
              message: "Task had no execution snapshot when trying to create a run attempt",
            },
            tx: prisma,
          });
          throw new ServiceValidationError("No snapshot", 404);
        }

        if (latestSnapshot.id !== snapshotId) {
          //if there is a big delay between the snapshot and the attempt, the snapshot might have changed
          //we just want to log because elsewhere it should have been put back into a state where it can be attempted
          this.logger.warn(
            "RunEngine.createRunAttempt(): snapshot has changed since the attempt was created, ignoring."
          );
          throw new ServiceValidationError("Snapshot changed", 409);
        }

        const environment = await this.#getAuthenticatedEnvironmentFromRun(runId, prisma);
        if (!environment) {
          throw new ServiceValidationError("Environment not found", 404);
        }

        const taskRun = await prisma.taskRun.findFirst({
          where: {
            id: runId,
          },
          include: {
            tags: true,
            lockedBy: {
              include: {
                worker: {
                  select: {
                    id: true,
                    version: true,
                    sdkVersion: true,
                    cliVersion: true,
                    supportsLazyAttempts: true,
                  },
                },
              },
            },
            batchItems: {
              include: {
                batchTaskRun: true,
              },
            },
          },
        });

        this.logger.debug("Creating a task run attempt", { taskRun });

        if (!taskRun) {
          throw new ServiceValidationError("Task run not found", 404);
        }

        span.setAttribute("projectId", taskRun.projectId);
        span.setAttribute("environmentId", taskRun.runtimeEnvironmentId);
        span.setAttribute("taskRunId", taskRun.id);
        span.setAttribute("taskRunFriendlyId", taskRun.friendlyId);

        if (taskRun.status === "CANCELED") {
          throw new ServiceValidationError("Task run is cancelled", 400);
        }

        if (!taskRun.lockedBy) {
          throw new ServiceValidationError("Task run is not locked", 400);
        }

        const queue = await prisma.taskQueue.findUnique({
          where: {
            runtimeEnvironmentId_name: {
              runtimeEnvironmentId: environment.id,
              name: taskRun.queue,
            },
          },
        });

        if (!queue) {
          throw new ServiceValidationError("Queue not found", 404);
        }

        //increment the attempt number (start at 1)
        const nextAttemptNumber = (taskRun.attemptNumber ?? 0) + 1;

        if (nextAttemptNumber > MAX_TASK_RUN_ATTEMPTS) {
          await this.#crash({
            runId: taskRun.id,
            error: {
              type: "INTERNAL_ERROR",
              code: "TASK_RUN_CRASHED",
              message: "Max attempts reached.",
            },
          });
          throw new ServiceValidationError("Max attempts reached", 400);
        }

        const result = await $transaction(
          prisma,
          async (tx) => {
            const run = await tx.taskRun.update({
              where: {
                id: taskRun.id,
              },
              data: {
                status: "EXECUTING",
                attemptNumber: nextAttemptNumber,
              },
              include: {
                tags: true,
                lockedBy: {
                  include: { worker: true },
                },
              },
            });

            const newSnapshot = await this.#createExecutionSnapshot(tx, {
              run,
              snapshot: {
                executionStatus: "EXECUTING",
                description: "Attempt created, starting execution",
              },
            });

            if (taskRun.ttl) {
              //don't expire the run, it's going to execute
              await this.worker.ack(`expireRun:${taskRun.id}`);
            }

            return { run, snapshot: newSnapshot };
          },
          (error) => {
            this.logger.error("RunEngine.createRunAttempt(): prisma.$transaction error", {
              code: error.code,
              meta: error.meta,
              stack: error.stack,
              message: error.message,
              name: error.name,
            });
            throw new ServiceValidationError(
              "Failed to update task run and execution snapshot",
              500
            );
          }
        );

        if (!result) {
          this.logger.error("RunEngine.createRunAttempt(): failed to create task run attempt", {
            runId: taskRun.id,
            nextAttemptNumber,
          });
          throw new ServiceValidationError("Failed to create task run attempt", 500);
        }

        const { run, snapshot } = result;

        const machinePreset = machinePresetFromConfig({
          machines: this.options.machines.machines,
          defaultMachine: this.options.machines.defaultMachine,
          config: taskRun.lockedBy.machineConfig ?? {},
        });

        const metadata = await parsePacket({
          data: taskRun.metadata ?? undefined,
          dataType: taskRun.metadataType,
        });

        const execution: TaskRunExecution = {
          task: {
            id: run.lockedBy!.slug,
            filePath: run.lockedBy!.filePath,
            exportName: run.lockedBy!.exportName,
          },
          attempt: {
            number: nextAttemptNumber,
            startedAt: latestSnapshot.updatedAt,
            //todo deprecate everything below
            id: generateFriendlyId("attempt"),
            backgroundWorkerId: run.lockedBy!.worker.id,
            backgroundWorkerTaskId: run.lockedBy!.id,
            status: "EXECUTING" as const,
          },
          run: {
            id: run.friendlyId,
            payload: run.payload,
            payloadType: run.payloadType,
            context: run.context,
            createdAt: run.createdAt,
            tags: run.tags.map((tag) => tag.name),
            isTest: run.isTest,
            idempotencyKey: run.idempotencyKey ?? undefined,
            startedAt: run.startedAt ?? run.createdAt,
            durationMs: run.usageDurationMs,
            costInCents: run.costInCents,
            baseCostInCents: run.baseCostInCents,
            maxAttempts: run.maxAttempts ?? undefined,
            version: run.lockedBy!.worker.version,
            metadata,
            maxDuration: run.maxDurationInSeconds ?? undefined,
          },
          queue: {
            id: queue.friendlyId,
            name: queue.name,
          },
          environment: {
            id: environment.id,
            slug: environment.slug,
            type: environment.type,
          },
          organization: {
            id: environment.organization.id,
            slug: environment.organization.slug,
            name: environment.organization.title,
          },
          project: {
            id: environment.project.id,
            ref: environment.project.externalRef,
            slug: environment.project.slug,
            name: environment.project.name,
          },
          batch:
            taskRun.batchItems[0] && taskRun.batchItems[0].batchTaskRun
              ? { id: taskRun.batchItems[0].batchTaskRun.friendlyId }
              : undefined,
          machine: machinePreset,
        };

        return {
          run,
          snapshot,
        };
      });
    });
  }

  /** How a run is completed */
  async completeRunAttempt({
    runId,
    snapshotId,
    completion,
  }: {
    runId: string;
    snapshotId: string;
    completion: TaskRunExecutionResult;
  }) {
    //todo
    //1. lock the run
    //2. get the latest snapshot
    //3. deal with completion errors
    //4. update the run status, create final snapshot
    //5. complete waitpoints

    return this.#trace("completeRunAttempt", { runId, snapshotId }, async (span) => {
      return this.runLock.lock([runId], 5_000, async (signal) => {
        const latestSnapshot = await this.#getLatestExecutionSnapshot(this.prisma, runId);
        if (!latestSnapshot) {
          throw new Error(`No execution snapshot found for TaskRun ${runId}`);
        }

        if (latestSnapshot.id !== snapshotId) {
          throw new ServiceValidationError("Snapshot ID doesn't match the latest snapshot", 400);
        }

        span.setAttribute("completionStatus", completion.ok);

        if (completion.ok) {
          const run = await this.prisma.taskRun.update({
            where: { id: runId },
            data: {
              status: "COMPLETED_SUCCESSFULLY",
              completedAt: new Date(),
              output: completion.output,
              outputType: completion.outputType,
              executionSnapshots: {
                create: {
                  executionStatus: "FINISHED",
                  description: "Task completed successfully",
                  runStatus: "COMPLETED_SUCCESSFULLY",
                  attemptNumber: latestSnapshot.attemptNumber,
                },
              },
            },
            select: {
              associatedWaitpoint: {
                select: {
                  id: true,
                },
              },
              project: {
                select: {
                  organizationId: true,
                },
              },
            },
          });
          await this.runQueue.acknowledgeMessage(run.project.organizationId, runId);

          if (!run.associatedWaitpoint) {
            throw new ServiceValidationError("No associated waitpoint found", 400);
          }

          await this.completeWaitpoint({
            id: run.associatedWaitpoint.id,
            output: completion.output
              ? { value: completion.output, type: completion.outputType }
              : undefined,
          });
        } else {
          const error = sanitizeError(completion.error);
          //todo look at CompleteAttemptService
          throw new NotImplementedError("TaskRun completion error handling not implemented yet");
        }
      });
    });
  }

  /** This is called to get the  */
  async resumeRun({
    runId,
    snapshotId,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    tx?: PrismaClientOrTransaction;
  }) {}

  async waitForDuration() {}

  async expire({ runId, tx }: { runId: string; tx?: PrismaClientOrTransaction }) {}

  /** This completes a waitpoint and updates all entries so the run isn't blocked,
   * if they're no longer blocked. This doesn't suffer from race conditions. */
  async completeWaitpoint({
    id,
    output,
  }: {
    id: string;
    output?: {
      value: string;
      type?: string;
    };
  }) {
    const waitpoint = await this.prisma.waitpoint.findUnique({
      where: { id },
    });

    if (!waitpoint) {
      throw new Error(`Waitpoint ${id} not found`);
    }

    if (waitpoint.status === "COMPLETED") {
      return;
    }

    await $transaction(
      this.prisma,
      async (tx) => {
        // 1. Find the TaskRuns associated with this waitpoint
        const affectedTaskRuns = await tx.taskRunWaitpoint.findMany({
          where: { waitpointId: id },
          select: { taskRunId: true },
        });

        if (affectedTaskRuns.length === 0) {
          throw new Error(`No TaskRunWaitpoints found for waitpoint ${id}`);
        }

        // 2. Delete the TaskRunWaitpoint entries for this specific waitpoint
        await tx.taskRunWaitpoint.deleteMany({
          where: { waitpointId: id },
        });

        // 3. Update the waitpoint status
        await tx.waitpoint.update({
          where: { id },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            output: output?.value,
            outputType: output?.type,
          },
        });

        // 4. Add the completed waitpoints to the snapshots
        for (const run of affectedTaskRuns) {
          await this.runLock.lock([run.taskRunId], 5_000, async (signal) => {
            const latestSnapshot = await this.#getLatestExecutionSnapshot(tx, run.taskRunId);
            if (!latestSnapshot) {
              throw new Error(`No execution snapshot found for TaskRun ${run.taskRunId}`);
            }

            await tx.taskRunExecutionSnapshot.update({
              where: { id: latestSnapshot.id },
              data: {
                completedWaitpoints: {
                  connect: { id },
                },
              },
            });
          });
        }

        // 5. Check which of the affected TaskRuns now have no waitpoints
        const taskRunsToResume = await tx.taskRun.findMany({
          where: {
            id: { in: affectedTaskRuns.map((run) => run.taskRunId) },
            blockedByWaitpoints: { none: {} },
          },
          include: {
            runtimeEnvironment: {
              select: {
                id: true,
                type: true,
                maximumConcurrencyLimit: true,
                project: { select: { id: true } },
                organization: { select: { id: true } },
              },
            },
          },
        });

        // 5. Continue the runs that have no more waitpoints
        for (const run of taskRunsToResume) {
          await this.#continueRun(run, run.runtimeEnvironment, tx);
        }
      },
      (error) => {
        this.logger.error(`Error completing waitpoint ${id}, retrying`, { error });
        throw error;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  /** Get required data to execute the run */
  async getRunExecutionData({
    runId,
    tx,
  }: {
    runId: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<RunExecutionData | null> {
    const prisma = tx ?? this.prisma;
    const snapshot = await this.#getLatestExecutionSnapshot(prisma, runId);
    if (!snapshot) {
      return null;
    }

    const executionData: RunExecutionData = {
      snapshot: {
        id: snapshot.id,
        executionStatus: snapshot.executionStatus,
        description: snapshot.description,
      },
      run: {
        id: snapshot.runId,
        status: snapshot.runStatus,
        attemptNumber: snapshot.attemptNumber ?? undefined,
      },
      checkpoint: snapshot.checkpoint
        ? {
            id: snapshot.checkpoint.id,
            type: snapshot.checkpoint.type,
            location: snapshot.checkpoint.location,
            imageRef: snapshot.checkpoint.imageRef,
            reason: snapshot.checkpoint.reason ?? undefined,
          }
        : undefined,
      completedWaitpoints: {},
    };
  }

  async quit() {
    //stop the run queue
    this.runQueue.quit();
    this.worker.stop();
  }

  async #systemFailure({
    runId,
    error,
    tx,
  }: {
    runId: string;
    error: TaskRunInternalError;
    tx?: PrismaClientOrTransaction;
  }) {}

  async #crash({
    runId,
    error,
    tx,
  }: {
    runId: string;
    error: TaskRunInternalError;
    tx?: PrismaClientOrTransaction;
  }) {}

  async #waitingForDeploy({ runId, tx }: { runId: string; tx?: PrismaClientOrTransaction }) {}

  //MARK: RunQueue

  /** The run can be added to the queue. When it's pulled from the queue it will be executed. */
  async #enqueueRun(
    run: TaskRun,
    env: MinimalAuthenticatedEnvironment,
    tx?: PrismaClientOrTransaction
  ) {
    const prisma = tx ?? this.prisma;

    const newSnapshot = await this.#createExecutionSnapshot(prisma, {
      run: run,
      snapshot: {
        executionStatus: "QUEUED",
        description: "Run was QUEUED",
      },
    });

    await this.runQueue.enqueueMessage({
      env,
      masterQueue: run.masterQueue,
      message: {
        runId: run.id,
        taskIdentifier: run.taskIdentifier,
        orgId: env.organization.id,
        projectId: env.project.id,
        environmentId: env.id,
        environmentType: env.type,
        queue: run.queue,
        concurrencyKey: run.concurrencyKey ?? undefined,
        timestamp: Date.now(),
      },
    });
  }

  async #continueRun(
    run: TaskRun,
    env: MinimalAuthenticatedEnvironment,
    tx?: PrismaClientOrTransaction
  ) {
    const prisma = tx ?? this.prisma;

    await this.runLock.lock([run.id], 5000, async (signal) => {
      const snapshot = await this.#getLatestExecutionSnapshot(prisma, run.id);
      if (!snapshot) {
        throw new Error(`RunEngine.#continueRun(): No snapshot found for run: ${run.id}`);
      }

      const completedWaitpoints = await this.#getExecutionSnapshotCompletedWaitpoints(
        prisma,
        snapshot.id
      );

      //run is still executing, send a message to the worker
      if (isExecuting(snapshot.executionStatus)) {
        const newSnapshot = await this.#createExecutionSnapshot(prisma, {
          run: run,
          snapshot: {
            executionStatus: "PENDING_EXECUTING",
            description: "Run was continued, whilst still executing.",
          },
          completedWaitpointIds: completedWaitpoints.map((waitpoint) => waitpoint.id),
        });

        //todo publish a notification in Redis that the Workers listen to
        //this will cause the Worker to check for new execution snapshots for its runs
      } else {
        const newSnapshot = await this.#createExecutionSnapshot(prisma, {
          run: run,
          snapshot: {
            executionStatus: "QUEUED",
            description: "Run was QUEUED, because it needs to be continued.",
          },
          completedWaitpointIds: completedWaitpoints.map((waitpoint) => waitpoint.id),
        });

        //todo instead this should be a call to unblock the run
        //we don't want to free up all the concurrency, so this isn't good
        // await this.runQueue.enqueueMessage({
        //   env,
        //   masterQueue: run.masterQueue,
        //   message: {
        //     runId: run.id,
        //     taskIdentifier: run.taskIdentifier,
        //     orgId: env.organization.id,
        //     projectId: env.project.id,
        //     environmentId: env.id,
        //     environmentType: env.type,
        //     queue: run.queue,
        //     concurrencyKey: run.concurrencyKey ?? undefined,
        //     timestamp: Date.now(),
        //   },
        // });
      }
    });
  }

  //MARK: - Waitpoints
  async #createRunAssociatedWaitpoint(
    tx: PrismaClientOrTransaction,
    { projectId, completedByTaskRunId }: { projectId: string; completedByTaskRunId: string }
  ) {
    return tx.waitpoint.create({
      data: {
        type: "RUN",
        status: "PENDING",
        idempotencyKey: nanoid(24),
        userProvidedIdempotencyKey: false,
        projectId,
        completedByTaskRunId,
      },
    });
  }

  async #createDateTimeWaitpoint(
    tx: PrismaClientOrTransaction,
    { projectId, completedAfter }: { projectId: string; completedAfter: Date }
  ) {
    const waitpoint = await tx.waitpoint.create({
      data: {
        type: "DATETIME",
        status: "PENDING",
        idempotencyKey: nanoid(24),
        userProvidedIdempotencyKey: false,
        projectId,
        completedAfter,
      },
    });

    await this.worker.enqueue({
      id: `waitpointCompleteDateTime.${waitpoint.id}`,
      job: "waitpointCompleteDateTime",
      payload: { waitpointId: waitpoint.id },
      availableAt: completedAfter,
    });

    return waitpoint;
  }

  async #blockRunWithWaitpoint(
    tx: PrismaClientOrTransaction,
    { orgId, runId, waitpoint }: { orgId: string; runId: string; waitpoint: Waitpoint }
  ) {
    await this.runLock.lock([runId], 5000, async (signal) => {
      //todo it would be better if we didn't remove from the queue, because this removes the payload
      //todo better would be to have a "block" function which remove it from the queue but doesn't remove the payload
      //todo release concurrency and make sure the run isn't in the queue
      // await this.runQueue.blockMessage(orgId, runId);

      const taskWaitpoint = await tx.taskRunWaitpoint.create({
        data: {
          taskRunId: runId,
          waitpointId: waitpoint.id,
          projectId: waitpoint.projectId,
        },
      });

      const latestSnapshot = await this.#getLatestExecutionSnapshot(tx, runId);

      if (latestSnapshot) {
        let newStatus: TaskRunExecutionStatus = "BLOCKED_BY_WAITPOINTS";
        if (
          latestSnapshot.executionStatus === "EXECUTING" ||
          latestSnapshot.executionStatus === "EXECUTING_WITH_WAITPOINTS"
        ) {
          newStatus = "EXECUTING_WITH_WAITPOINTS";
        }

        //if the state has changed, create a new snapshot
        if (newStatus !== latestSnapshot.executionStatus) {
          await this.#createExecutionSnapshot(tx, {
            run: {
              id: latestSnapshot.runId,
              status: latestSnapshot.runStatus,
              attemptNumber: latestSnapshot.attemptNumber,
            },
            snapshot: {
              executionStatus: newStatus,
              description: "Run was blocked by a waitpoint.",
            },
          });
        }
      }
    });
  }

  //#region TaskRunExecutionSnapshots
  async #createExecutionSnapshot(
    prisma: PrismaClientOrTransaction,
    {
      run,
      snapshot,
      checkpointId,
      completedWaitpointIds,
    }: {
      run: { id: string; status: TaskRunStatus; attemptNumber?: number | null };
      snapshot: {
        executionStatus: TaskRunExecutionStatus;
        description: string;
      };
      checkpointId?: string;
      completedWaitpointIds?: string[];
    }
  ) {
    const newSnapshot = await prisma.taskRunExecutionSnapshot.create({
      data: {
        engine: "V2",
        executionStatus: snapshot.executionStatus,
        description: snapshot.description,
        runId: run.id,
        runStatus: run.status,
        attemptNumber: run.attemptNumber ?? undefined,
        checkpointId: checkpointId ?? undefined,
      },
      include: {
        checkpoint: true,
      },
    });

    //set heartbeat (if relevant)
    await this.#setExecutionSnapshotHeartbeat({
      status: newSnapshot.executionStatus,
      runId: run.id,
      snapshotId: newSnapshot.id,
    });

    return newSnapshot;
  }

  async #setExecutionSnapshotHeartbeat({
    status,
    runId,
    snapshotId,
  }: {
    status: TaskRunExecutionStatus;
    runId: string;
    snapshotId: string;
  }) {
    switch (status) {
      case "RUN_CREATED":
      case "FINISHED":
      case "BLOCKED_BY_WAITPOINTS":
      case "QUEUED": {
        //we don't need to heartbeat these statuses
        break;
      }
      case "PENDING_EXECUTING":
      case "PENDING_CANCEL": {
        await this.#startHeartbeating({
          runId,
          snapshotId,
          intervalSeconds: 60,
        });
        break;
      }
      case "EXECUTING":
      case "EXECUTING_WITH_WAITPOINTS": {
        await this.#startHeartbeating({
          runId,
          snapshotId,
          intervalSeconds: 60 * 15,
        });
        break;
      }
      default: {
        assertNever(status);
      }
    }
  }

  async #getLatestExecutionSnapshot(prisma: PrismaClientOrTransaction, runId: string) {
    return prisma.taskRunExecutionSnapshot.findFirst({
      where: { runId },
      include: {
        completedWaitpoints: true,
        checkpoint: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async #getExecutionSnapshotCompletedWaitpoints(
    prisma: PrismaClientOrTransaction,
    snapshotId: string
  ) {
    const waitpoints = await prisma.taskRunExecutionSnapshot.findFirst({
      where: { id: snapshotId },
      include: {
        completedWaitpoints: true,
      },
    });

    //deduplicate waitpoints
    const waitpointIds = new Set<string>();
    return (
      waitpoints?.completedWaitpoints.filter((waitpoint) => {
        if (waitpointIds.has(waitpoint.id)) {
          return false;
        } else {
          waitpointIds.add(waitpoint.id);
          return true;
        }
      }) ?? []
    );
  }

  //#endregion

  //#region Heartbeat
  async #startHeartbeating({
    runId,
    snapshotId,
    intervalSeconds,
  }: {
    runId: string;
    snapshotId: string;
    intervalSeconds: number;
  }) {
    await this.worker.enqueue({
      id: `heartbeatSnapshot.${snapshotId}`,
      job: "heartbeatSnapshot",
      payload: { snapshotId, runId },
      availableAt: new Date(Date.now() + intervalSeconds * 1000),
    });
  }

  async #extendHeartbeatTimeout({
    runId,
    snapshotId,
    intervalSeconds,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    intervalSeconds: number;
    tx?: PrismaClientOrTransaction;
  }) {
    const latestSnapshot = await this.#getLatestExecutionSnapshot(tx ?? this.prisma, runId);
    if (latestSnapshot?.id !== snapshotId) {
      this.logger.log(
        "RunEngine.#extendHeartbeatTimeout() no longer the latest snapshot, stopping the heartbeat.",
        {
          runId,
          snapshotId,
          latestSnapshot: latestSnapshot,
        }
      );

      await this.worker.ack(`heartbeatSnapshot.${snapshotId}`);
      return;
    }

    //it's the same as creating a new heartbeat
    await this.#startHeartbeating({ runId, snapshotId, intervalSeconds });
  }

  async #handleStalledSnapshot({
    runId,
    snapshotId,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    tx?: PrismaClientOrTransaction;
  }) {
    const latestSnapshot = await this.#getLatestExecutionSnapshot(tx ?? this.prisma, runId);
    if (!latestSnapshot) {
      this.logger.error("RunEngine.#handleStalledSnapshot() no latest snapshot found", {
        runId,
        snapshotId,
      });
      return;
    }

    if (latestSnapshot?.id !== snapshotId) {
      this.logger.log(
        "RunEngine.#handleStalledSnapshot() no longer the latest snapshot, stopping the heartbeat.",
        {
          runId,
          snapshotId,
          latestSnapshot: latestSnapshot,
        }
      );

      await this.worker.ack(`heartbeatSnapshot.${snapshotId}`);
      return;
    }

    this.logger.log("RunEngine.#handleStalledSnapshot() handling stalled snapshot", {
      runId,
      snapshot: latestSnapshot,
    });

    //todo fail attempt if there is one?

    switch (latestSnapshot.executionStatus) {
      case "RUN_CREATED": {
        //we need to check if the run is still created
        throw new NotImplementedError("Not implemented RUN_CREATED");
      }
      case "QUEUED": {
        //we need to check if the run is still QUEUED
        throw new NotImplementedError("Not implemented QUEUED");
      }
      case "PENDING_EXECUTING": {
        //we need to check if the run is still dequeued
        throw new NotImplementedError("Not implemented DEQUEUED_FOR_EXECUTION");
      }
      case "EXECUTING": {
        //we need to check if the run is still executing
        throw new NotImplementedError("Not implemented EXECUTING");
      }
      case "EXECUTING_WITH_WAITPOINTS": {
        //we need to check if the run is still executing
        throw new NotImplementedError("Not implemented EXECUTING_WITH_WAITPOINTS");
      }
      case "BLOCKED_BY_WAITPOINTS": {
        //we need to check if the waitpoints are still blocking the run
        throw new NotImplementedError("Not implemented BLOCKED_BY_WAITPOINTS");
      }
      case "PENDING_CANCEL": {
        //we need to check if the run is still pending cancel
        throw new NotImplementedError("Not implemented PENDING_CANCEL");
      }
      case "FINISHED": {
        //we need to check if the run is still finished
        throw new NotImplementedError("Not implemented FINISHED");
      }
      default: {
        assertNever(latestSnapshot.executionStatus);
      }
    }
  }

  //#endregion

  async #getAuthenticatedEnvironmentFromRun(runId: string, tx?: PrismaClientOrTransaction) {
    const prisma = tx ?? this.prisma;
    const taskRun = await prisma.taskRun.findUnique({
      where: {
        id: runId,
      },
      include: {
        runtimeEnvironment: {
          include: {
            organization: true,
            project: true,
          },
        },
      },
    });

    if (!taskRun) {
      return;
    }

    return taskRun?.runtimeEnvironment;
  }

  async #trace<T>(
    trace: string,
    attributes: Attributes | undefined,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    return this.tracer.startActiveSpan(
      `${this.constructor.name}.${trace}`,
      { attributes, kind: SpanKind.SERVER },
      async (span) => {
        try {
          return await fn(span);
        } catch (e) {
          if (e instanceof ServiceValidationError) {
            throw e;
          }

          if (e instanceof Error) {
            span.recordException(e);
          } else {
            span.recordException(new Error(String(e)));
          }

          throw e;
        } finally {
          span.end();
        }
      }
    );
  }
}

export class ServiceValidationError extends Error {
  constructor(
    message: string,
    public status?: number
  ) {
    super(message);
    this.name = "ServiceValidationError";
  }
}

//todo temporary during development
class NotImplementedError extends Error {
  constructor(message: string) {
    console.error("NOT IMPLEMENTED YET", { message });
    super(message);
  }
}
