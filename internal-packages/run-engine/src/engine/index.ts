import { RunnerOptions, ZodWorker } from "@internal/zod-worker";
import { trace } from "@opentelemetry/api";
import { Logger } from "@trigger.dev/core/logger";
import { QueueOptions } from "@trigger.dev/core/v3";
import { generateFriendlyId, parseNaturalLanguageDuration } from "@trigger.dev/core/v3/apps";
import {
  $transaction,
  PrismaClient,
  PrismaClientOrTransaction,
  TaskRun,
  Waitpoint,
} from "@trigger.dev/database";
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
  zodWorker: RunnerOptions & {
    shutdownTimeoutInMs: number;
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
  resumeParentOnCompletion: boolean;
  depth: number;
  metadata?: string;
  metadataType?: string;
  seedMetadata?: string;
  seedMetadataType?: string;
  isWait: boolean;
};

const schema = {
  "runengine.waitpointCompleteDateTime": z.object({
    waitpointId: z.string(),
  }),
  "runengine.expireRun": z.object({
    runId: z.string(),
  }),
};

type EngineWorker = ZodWorker<typeof schema>;

export class RunEngine {
  private redis: Redis;
  private prisma: PrismaClient;
  private redlock: Redlock;
  private runQueue: RunQueue;
  private zodWorker: EngineWorker;

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

    this.zodWorker = new ZodWorker({
      name: "runQueueWorker",
      prisma: options.prisma,
      replica: options.prisma,
      logger: new Logger("RunQueueWorker", "debug"),
      runnerOptions: options.zodWorker,
      shutdownTimeoutInMs: options.zodWorker.shutdownTimeoutInMs,
      schema,
      tasks: {
        "runengine.waitpointCompleteDateTime": {
          priority: 0,
          maxAttempts: 10,
          handler: async (payload, job) => {
            await this.#completeWaitpoint(this.prisma, payload.waitpointId);
          },
        },
        "runengine.expireRun": {
          priority: 0,
          maxAttempts: 10,
          handler: async (payload, job) => {
            await this.expireRun(payload.runId);
          },
        },
      },
    });
  }

  //MARK: - Run functions

  /** "Triggers" one run, which creates the run
   */
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
      isWait,
    }: TriggerParams,
    tx?: PrismaClientOrTransaction
  ) {
    const prisma = tx ?? this.prisma;

    //create run
    const taskRun = await prisma.taskRun.create({
      data: {
        status: delayUntil ? "DELAYED" : "PENDING",
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
      },
    });

    await this.redlock.using([taskRun.id], 5000, async (signal) => {
      //create associated waitpoint (this completes when the run completes)
      const associatedWaitpoint = await this.#createRunAssociatedWaitpoint(prisma, {
        projectId: environment.project.id,
        completedByTaskRunId: taskRun.id,
      });

      if (isWait && parentTaskRunId) {
        //this will block the parent run from continuing until this waitpoint is completed (and removed)
        await this.#blockRunWithWaitpoint(prisma, {
          orgId: environment.organization.id,
          runId: parentTaskRunId,
          waitpoint: associatedWaitpoint,
        });
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
          await this.zodWorker.enqueue(
            "runengine.expireRun",
            { runId: taskRun.id },
            { tx, runAt: expireAt, jobKey: `runengine.expireRun.${taskRun.id}` }
          );
        }
      }

      await this.enqueueRun(taskRun, environment, prisma);
    });

    //todo release parent concurrency (for the project, task, and environment, but not for the queue?)
    //todo if this has been triggered with triggerAndWait or batchTriggerAndWait

    return taskRun;
  }

  /** Triggers multiple runs.
   * This doesn't start execution, but it will create a batch and schedule them for execution.
   */
  async batchTrigger() {}

  /** The run can be added to the queue. When it's pulled from the queue it will be executed. */
  async enqueueRun(
    run: TaskRun,
    env: MinimalAuthenticatedEnvironment,
    tx?: PrismaClientOrTransaction
  ) {
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

    //todo update the TaskRunExecutionSnapshot
  }

  /** We want to actually execute the run, this could be a continuation of a previous execution.
   * This is called from the queue, when the run has been pulled. */
  //todo think more about this, when do we create the attempt?
  //todo what does this actually do?
  //todo how does it get sent to the worker? DEV and PROD
  async prepareForExecution(runId: string) {}

  async prepareForAttempt(runId: string) {}

  async complete(runId: string, completion: any) {}

  async expireRun(runId: string) {}

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

    await this.zodWorker.enqueue(
      "runengine.waitpointCompleteDateTime",
      { waitpointId: waitpoint.id },
      { tx, runAt: completedAfter, jobKey: `waitpointCompleteDateTime.${waitpoint.id}` }
    );

    return waitpoint;
  }

  async #blockRunWithWaitpoint(
    tx: PrismaClientOrTransaction,
    { orgId, runId, waitpoint }: { orgId: string; runId: string; waitpoint: Waitpoint }
  ) {
    //todo it would be better if we didn't remove from the queue, because this removes the payload
    //todo better would be to have a "block" function which remove it from the queue but doesn't remove the payload
    await this.runQueue.acknowledgeMessage(orgId, runId);

    return tx.taskRunWaitpoint.create({
      data: {
        taskRunId: runId,
        waitpointId: waitpoint.id,
        projectId: waitpoint.projectId,
      },
    });
  }

  /** Any runs blocked by this waitpoint will get continued (if no other waitpoints exist) */
  async #completeWaitpoint(prisma: PrismaClientOrTransaction, id: string) {
    const waitpoint = await prisma.waitpoint.findUnique({
      where: { id },
    });

    if (!waitpoint) {
      throw new Error(`Waitpoint ${id} not found`);
    }

    if (waitpoint.status === "COMPLETED") {
      return;
    }

    await $transaction(
      prisma,
      async (tx) => {
        const blockers = await tx.taskRunWaitpoint.findMany({
          where: { waitpointId: id },
        });

        for (const blocker of blockers) {
          //remove the waitpoint
          await tx.taskRunWaitpoint.delete({
            where: { id: blocker.id },
          });

          const blockedRun = await tx.taskRun.findFirst({
            where: { id: blocker.taskRunId },
            include: {
              _count: {
                select: {
                  blockedByWaitpoints: true,
                },
              },
              runtimeEnvironment: {
                select: {
                  id: true,
                  type: true,
                  maximumConcurrencyLimit: true,
                  project: {
                    select: {
                      id: true,
                    },
                  },
                  organization: {
                    select: {
                      id: true,
                    },
                  },
                },
              },
            },
          });

          if (blockedRun && blockedRun._count.blockedByWaitpoints === 0) {
            await this.enqueueRun(blockedRun, blockedRun.runtimeEnvironment, tx);
          }
        }

        await tx.waitpoint.update({
          where: { id },
          data: { status: "COMPLETED" },
        });
      },
      (error) => {
        throw error;
      }
    );
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
