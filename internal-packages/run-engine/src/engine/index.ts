import { Worker, type WorkerConcurrencyOptions } from "@internal/redis-worker";
import { Attributes, Span, SpanKind, trace, Tracer } from "@opentelemetry/api";
import { Logger } from "@trigger.dev/core/logger";
import {
  MachinePreset,
  MachinePresetName,
  parsePacket,
  QueueOptions,
  TaskRunExecution,
  TaskRunInternalError,
} from "@trigger.dev/core/v3";
import { generateFriendlyId, parseNaturalLanguageDuration } from "@trigger.dev/core/v3/apps";
import {
  $transaction,
  Prisma,
  PrismaClient,
  PrismaClientOrTransaction,
  TaskRun,
  TaskRunAttemptStatus,
  TaskRunExecutionStatus,
  TaskRunStatus,
  Waitpoint,
} from "@trigger.dev/database";
import assertNever from "assert-never";
import { Redis, type RedisOptions } from "ioredis";
import { nanoid } from "nanoid";
import Redlock from "redlock";
import { z } from "zod";
import { RunQueue } from "../run-queue";
import { SimpleWeightedChoiceStrategy } from "../run-queue/simpleWeightedPriorityStrategy";
import { MinimalAuthenticatedEnvironment } from "../shared";
import { MAX_TASK_RUN_ATTEMPTS } from "./consts";
import { machinePresetFromConfig } from "./machinePresets";

type Options = {
  redis: RedisOptions;
  prisma: PrismaClient;
  worker: WorkerConcurrencyOptions & {
    pollIntervalMs?: number;
  };
  machines: {
    defaultMachine: MachinePresetName;
    machines: Record<string, MachinePreset>;
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
  parentTaskRunAttemptId?: string;
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
  private redlock: Redlock;
  runQueue: RunQueue;
  private worker: EngineWorker;
  private logger = new Logger("RunEngine", "debug");
  private tracer: Tracer;

  constructor(private readonly options: Options) {
    this.prisma = options.prisma;
    this.redis = new Redis(options.redis);
    this.redlock = new Redlock([this.redis], {
      driftFactor: 0.01,
      retryCount: 10,
      retryDelay: 200, // time in ms
      retryJitter: 200, // time in ms
      automaticExtensionThreshold: 500, // time in ms
    });

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
          await this.#completeWaitpoint(payload.waitpointId);
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
      parentTaskRunAttemptId,
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
            parentTaskRunAttemptId,
            rootTaskRunId,
            batchId,
            resumeParentOnCompletion,
            depth,
            metadata,
            metadataType,
            seedMetadata,
            seedMetadataType,
            executionSnapshot: {
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

        await this.redlock.using([taskRun.id], 5000, async (signal) => {
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
          if (signal.aborted) {
            throw signal.error;
          }

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
          if (signal.aborted) {
            throw signal.error;
          }

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
  }) {
    const prisma = tx ?? this.prisma;
    return this.#trace("createRunAttempt", { consumerId, masterQueue }, async (span) => {
      const message = await this.runQueue.dequeueMessageInSharedQueue(consumerId, masterQueue);
      if (!message) {
        return null;
      }

      span.setAttribute("runId", message.messageId);

      const newSnapshot = await this.redlock.using([message.messageId], 5000, async (signal) => {
        const snapshot = await this.#getLatestExecutionSnapshot(prisma, message.messageId);
        if (!snapshot) {
          throw new Error(
            `RunEngine.dequeueFromMasterQueue(): No snapshot found for run: ${message.messageId}`
          );
        }

        if (!["QUEUED", "BLOCKED_BY_WAITPOINTS"].includes(snapshot.executionStatus)) {
          await this.#systemFailure({
            runId: message.messageId,
            error: {
              type: "INTERNAL_ERROR",
              code: "TASK_DEQUEUED_INVALID_STATE",
              message: `Task was in the ${snapshot.executionStatus} state when it was dequeued for execution.`,
            },
            tx: prisma,
          });
          throw new Error(
            `RunEngine.dequeueFromMasterQueue(): Run is not in a valid state to be dequeued: ${message.messageId}\n ${snapshot.id}:${snapshot.executionStatus}`
          );
        }

        const newSnapshot = await this.#createExecutionSnapshot(prisma, {
          run: {
            id: message.messageId,
            status: snapshot.runStatus,
          },
          snapshot: {
            executionStatus: "DEQUEUED_FOR_EXECUTION",
            description: "Run was dequeued for execution",
          },
        });

        return newSnapshot;
      });

      return newSnapshot;
    });
  }

  async createRunAttempt({
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
      return this.redlock.using([runId], 5000, async (signal) => {
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
            attempts: {
              take: 1,
              orderBy: {
                number: "desc",
              },
            },
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

        const nextAttemptNumber = taskRun.attempts[0] ? taskRun.attempts[0].number + 1 : 1;

        if (nextAttemptNumber > MAX_TASK_RUN_ATTEMPTS) {
          await this.#crash({
            runId: taskRun.id,
            error: {
              type: "INTERNAL_ERROR",
              code: "TASK_RUN_CRASHED",
              message: taskRun.lockedBy.worker.supportsLazyAttempts
                ? "Max attempts reached."
                : "Max attempts reached. Please upgrade your CLI and SDK.",
            },
          });

          throw new ServiceValidationError("Max attempts reached", 400);
        }

        const result = await $transaction(
          prisma,
          async (tx) => {
            const attempt = await tx.taskRunAttempt.create({
              data: {
                number: nextAttemptNumber,
                friendlyId: generateFriendlyId("attempt"),
                taskRunId: taskRun.id,
                startedAt: new Date(),
                backgroundWorkerId: taskRun.lockedBy!.worker.id,
                backgroundWorkerTaskId: taskRun.lockedBy!.id,
                status: "EXECUTING",
                queueId: queue.id,
                runtimeEnvironmentId: environment.id,
              },
            });

            const run = await tx.taskRun.update({
              where: {
                id: taskRun.id,
              },
              data: {
                status: "EXECUTING",
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
              attempt,
              snapshot: {
                executionStatus: "EXECUTING",
                description: "Attempt created, starting execution",
              },
            });

            if (taskRun.ttl) {
              //don't expire the run, it's going to execute
              await this.worker.ack(`expireRun:${taskRun.id}`);
            }

            return { run, attempt, snapshot: newSnapshot };
          },
          (error) => {
            this.logger.error("RunEngine.createRunAttempt(): prisma.$transaction error", {
              code: error.code,
              meta: error.meta,
              stack: error.stack,
              message: error.message,
              name: error.name,
            });
          }
        );

        if (!result) {
          this.logger.error("RunEngine.createRunAttempt(): failed to create task run attempt", {
            runId: taskRun.id,
            nextAttemptNumber,
          });
          throw new ServiceValidationError("Failed to create task run attempt", 500);
        }

        const { run, attempt, snapshot } = result;

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
            id: attempt.friendlyId,
            number: attempt.number,
            startedAt: attempt.startedAt ?? attempt.createdAt,
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
        };

        return {
          run,
          attempt,
          snapshot,
        };
      });
    });
  }

  async waitForDuration() {}

  async complete(runId: string, completion: any) {}

  async expire({ runId, tx }: { runId: string; tx?: PrismaClientOrTransaction }) {}

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

    await this.redlock.using([run.id], 5000, async (signal) => {
      const snapshot = await this.#getLatestExecutionSnapshot(prisma, run.id);
      if (!snapshot) {
        throw new Error(`RunEngine.#continueRun(): No snapshot found for run: ${run.id}`);
      }

      //run is still executing, send a message to the worker
      if (snapshot.executionStatus === "EXECUTING" && snapshot.worker) {
        const newSnapshot = await this.#createExecutionSnapshot(prisma, {
          run: run,
          snapshot: {
            executionStatus: "EXECUTING",
            description: "Run was continued, whilst still executing.",
          },
        });

        //todo send a message to the worker somehow
        // await this.#sendMessageToWorker();
        throw new NotImplementedError(
          "RunEngine.#continueRun(): continue executing run, not implemented yet"
        );
      }

      const newSnapshot = await this.#createExecutionSnapshot(prisma, {
        run: run,
        snapshot: {
          executionStatus: "QUEUED",
          description: "Run was QUEUED, because it needs to be continued.",
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
    //todo it would be better if we didn't remove from the queue, because this removes the payload
    //todo better would be to have a "block" function which remove it from the queue but doesn't remove the payload

    //todo release concurrency and make sure the run isn't in the queue
    // await this.runQueue.blockMessage(orgId, runId);

    throw new NotImplementedError("Not implemented #blockRunWithWaitpoint");

    return tx.taskRunWaitpoint.create({
      data: {
        taskRunId: runId,
        waitpointId: waitpoint.id,
        projectId: waitpoint.projectId,
      },
    });
  }

  /** This completes a waitpoint and then continues any runs blocked by the waitpoint,
   * if they're no longer blocked. This doesn't suffer from race conditions. */
  async #completeWaitpoint(id: string) {
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
          data: { status: "COMPLETED" },
        });

        // 4. Check which of the affected TaskRuns now have no waitpoints
        const taskRunsToResume = await tx.taskRun.findMany({
          where: {
            id: { in: affectedTaskRuns.map((run) => run.taskRunId) },
            blockedByWaitpoints: { none: {} },
            status: { in: ["PENDING", "WAITING_TO_RESUME"] },
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

  //MARK: - TaskRunExecutionSnapshots
  async #createExecutionSnapshot(
    prisma: PrismaClientOrTransaction,
    {
      run,
      attempt,
      snapshot,
    }: {
      run: { id: string; status: TaskRunStatus };
      attempt?: { id: string; status: TaskRunAttemptStatus };
      snapshot: {
        executionStatus: TaskRunExecutionStatus;
        description: string;
      };
    }
  ) {
    const newSnapshot = await prisma.taskRunExecutionSnapshot.create({
      data: {
        engine: "V2",
        executionStatus: snapshot.executionStatus,
        description: snapshot.description,
        runId: run.id,
        runStatus: run.status,
        currentAttemptId: attempt?.id,
        currentAttemptStatus: attempt?.status,
      },
    });

    //create heartbeat (if relevant)
    switch (snapshot.executionStatus) {
      case "RUN_CREATED":
      case "QUEUED":
      case "BLOCKED_BY_WAITPOINTS":
      case "FINISHED":
      case "DEQUEUED_FOR_EXECUTION": {
        await this.#startHeartbeating({
          runId: run.id,
          snapshotId: newSnapshot.id,
          intervalSeconds: 60,
        });
        break;
      }
      case "EXECUTING": {
        await this.#startHeartbeating({
          runId: run.id,
          snapshotId: newSnapshot.id,
          intervalSeconds: 60 * 15,
        });
        break;
      }
    }

    return newSnapshot;
  }

  async #getLatestExecutionSnapshot(prisma: PrismaClientOrTransaction, runId: string) {
    return prisma.taskRunExecutionSnapshot.findFirst({
      include: { worker: true },
      where: { runId },
      orderBy: { createdAt: "desc" },
    });
  }

  //MARK: - Heartbeat
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
      case "BLOCKED_BY_WAITPOINTS": {
        //we need to check if the waitpoints are still blocking the run
        throw new NotImplementedError("Not implemented BLOCKED_BY_WAITPOINTS");
      }
      case "DEQUEUED_FOR_EXECUTION": {
        //we need to check if the run is still dequeued
        throw new NotImplementedError("Not implemented DEQUEUED_FOR_EXECUTION");
      }
      case "QUEUED": {
        //we need to check if the run is still QUEUED
        throw new NotImplementedError("Not implemented QUEUED");
      }
      case "EXECUTING": {
        //we need to check if the run is still executing
        throw new NotImplementedError("Not implemented EXECUTING");
      }
      case "FINISHED": {
        //we need to check if the run is still finished
        throw new NotImplementedError("Not implemented FINISHED");
      }
      case "RUN_CREATED": {
        //we need to check if the run is still created
        throw new NotImplementedError("Not implemented RUN_CREATED");
      }
      default: {
        assertNever(latestSnapshot.executionStatus);
      }
    }
  }

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

class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/*
Starting execution flow:

1. Run id is pulled from a queue
2. Prepare the run for an attempt (returns data to send to the worker)
  a. The run is marked as "waiting to start"?
  b. Create a TaskRunState with the run id, and the state "waiting to start".
  c. Start a heartbeat with the TaskRunState id, in case it never starts.
3. The run is sent to the worker
4. When the worker has received the run, it ask the platform for an attempt
5. The attempt is created
  a. The attempt is created
  b. The TaskRunState is updated to "EXECUTING"
  c. Start a heartbeat with the TaskRunState id.
  c. The TaskRun is updated to "EXECUTING"
6. A response is sent back to the worker with the attempt data
7. The code executes...
*/
