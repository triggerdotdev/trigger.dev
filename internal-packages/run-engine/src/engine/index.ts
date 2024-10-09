import { Worker, type WorkerConcurrencyOptions } from "@internal/redis-worker";
import { trace } from "@opentelemetry/api";
import { Logger } from "@trigger.dev/core/logger";
import { QueueOptions } from "@trigger.dev/core/v3";
import { generateFriendlyId, parseNaturalLanguageDuration } from "@trigger.dev/core/v3/apps";
import {
  $transaction,
  Prisma,
  PrismaClient,
  PrismaClientOrTransaction,
  TaskRun,
  Waitpoint,
} from "@trigger.dev/database";
import assertNever from "assert-never";
import { Redis, type RedisOptions } from "ioredis";
import Redlock from "redlock";
import { z } from "zod";
import { RunQueue } from "../run-queue";
import { SimpleWeightedChoiceStrategy } from "../run-queue/simpleWeightedPriorityStrategy";
import { MinimalAuthenticatedEnvironment } from "../shared";
import { nanoid } from "nanoid";

type Options = {
  redis: RedisOptions;
  prisma: PrismaClient;
  worker: WorkerConcurrencyOptions & {
    pollIntervalMs?: number;
  };
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
          await this.expireRun(payload.runId);
        },
      },
    });
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

        await this.#blockRunWithWaitpoint(prisma, {
          orgId: environment.organization.id,
          runId: taskRun.id,
          waitpoint: delayWaitpoint,
        });
      }

      if (!taskRun.delayUntil && taskRun.ttl) {
        const expireAt = parseNaturalLanguageDuration(taskRun.ttl);

        if (expireAt) {
          await this.worker.enqueue({ job: "expireRun", payload: { runId: taskRun.id } });
        }
      }

      //Make sure lock extension succeeded
      if (signal.aborted) {
        throw signal.error;
      }

      await this.#enqueueRun(taskRun, environment, prisma);
    });

    //todo release parent concurrency (for the project, task, and environment, but not for the queue?)
    //todo if this has been triggered with triggerAndWait or batchTriggerAndWait

    return taskRun;
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
  async dequeueFromMasterQueue(consumerId: string, masterQueue: string) {
    const message = await this.runQueue.dequeueMessageInSharedQueue(consumerId, masterQueue);
    if (!message) {
      return null;
    }

    const newSnapshot = await this.redlock.using([message.messageId], 5000, async (signal) => {
      const snapshot = await this.#getLatestExecutionSnapshot(message.messageId);
      if (!snapshot) {
        throw new Error(
          `RunEngine.dequeueFromMasterQueue(): No snapshot found for run: ${message.messageId}`
        );
      }

      if (!["QUEUED", "BLOCKED_BY_WAITPOINTS"].includes(snapshot.executionStatus)) {
        throw new Error(
          `RunEngine.dequeueFromMasterQueue(): Run is not in a valid state to be dequeued: ${message.messageId}\n ${snapshot.id}:${snapshot.executionStatus}`
        );
      }

      //create new snapshot
      const newSnapshot = await this.prisma.taskRunExecutionSnapshot.create({
        data: {
          runId: message.messageId,
          engine: "V2",
          executionStatus: "DEQUEUED_FOR_EXECUTION",
          description: "Run was dequeued for execution",
          runStatus: snapshot.runStatus,
        },
      });

      //todo create heartbeat, associated with this snapshot
      await this.#startHeartbeating({
        runId: message.messageId,
        snapshotId: newSnapshot.id,
        intervalSeconds: 60,
      });

      return newSnapshot;
    });

    return newSnapshot;
  }

  async createRunAttempt(runId: string, snapshotId: string) {
    //todo create the run attempt, update the execution status, start a heartbeat
  }

  async waitForDuration() {}

  async complete(runId: string, completion: any) {}

  async expireRun(runId: string) {}

  //MARK: RunQueue

  /** The run can be added to the queue. When it's pulled from the queue it will be executed. */
  async #enqueueRun(
    run: TaskRun,
    env: MinimalAuthenticatedEnvironment,
    tx?: PrismaClientOrTransaction
  ) {
    const prisma = tx ?? this.prisma;

    await prisma.taskRunExecutionSnapshot.create({
      data: {
        runId: run.id,
        engine: "V2",
        executionStatus: "QUEUED",
        description: "Run was QUEUED",
        runStatus: run.status,
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
      await prisma.taskRunExecutionSnapshot.create({
        data: {
          runId: run.id,
          engine: "V2",
          executionStatus: "QUEUED",
          description: "Run was QUEUED",
          runStatus: run.status,
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

    throw new Error("Not implemented #blockRunWithWaitpoint");

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
  async #getLatestExecutionSnapshot(runId: string) {
    return this.prisma.taskRunExecutionSnapshot.findFirst({
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
  }: {
    runId: string;
    snapshotId: string;
    intervalSeconds: number;
  }) {
    const latestSnapshot = await this.#getLatestExecutionSnapshot(runId);
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

  async #handleStalledSnapshot({ runId, snapshotId }: { runId: string; snapshotId: string }) {
    const latestSnapshot = await this.#getLatestExecutionSnapshot(runId);
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

    switch (latestSnapshot.executionStatus) {
      case "BLOCKED_BY_WAITPOINTS": {
        //we need to check if the waitpoints are still blocking the run
        throw new Error("Not implemented BLOCKED_BY_WAITPOINTS");
      }
      case "DEQUEUED_FOR_EXECUTION": {
        //todo probably put it back in the queue
        //we need to check if the run is still dequeued
        throw new Error("Not implemented DEQUEUED_FOR_EXECUTION");
      }
      case "QUEUED": {
        //we need to check if the run is still QUEUED
        throw new Error("Not implemented QUEUED");
      }
      case "EXECUTING": {
        //we need to check if the run is still executing
        throw new Error("Not implemented EXECUTING");
      }
      case "FINISHED": {
        //we need to check if the run is still finished
        throw new Error("Not implemented FINISHED");
      }
      case "RUN_CREATED": {
        //we need to check if the run is still created
        throw new Error("Not implemented RUN_CREATED");
      }
      default: {
        assertNever(latestSnapshot.executionStatus);
      }
    }

    //todo we need to return the run to the queue in the correct state.
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
