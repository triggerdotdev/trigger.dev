import { PrismaClient, Prisma, PrismaClientOrTransaction } from "@trigger.dev/database";
import { Redis, type RedisOptions } from "ioredis";
import Redlock from "redlock";
import { AuthenticatedEnvironment, MinimalAuthenticatedEnvironment } from "../shared";
import { QueueOptions } from "@trigger.dev/core/v3";
import { RunQueue } from "../run-queue";

type Options = {
  redis: RedisOptions;
  prisma: PrismaClientOrTransaction;
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

export class RunEngine {
  private redis: Redis;
  private prisma: PrismaClientOrTransaction;
  private redlock: Redlock;

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
  }

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
    //todo create a waitable
    const prisma = tx ?? this.prisma;

    //todo attach waitable to the run

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
      if (signal.aborted) {
        throw signal.error;
      }

      if (isWait) {
        //todo block the parentTaskRun with this runId
      }

      if (dependentAttempt) {
        await prisma.taskRunDependency.create({
          data: {
            taskRunId: taskRun.id,
            dependentAttemptId: dependentAttempt.id,
          },
        });
      } else if (dependentBatchRun) {
        await prisma.taskRunDependency.create({
          data: {
            taskRunId: taskRun.id,
            dependentBatchRunId: dependentBatchRun.id,
          },
        });
      }

      if (queue) {
        const concurrencyLimit =
          typeof body.options.queue.concurrencyLimit === "number"
            ? Math.max(0, body.options.queue.concurrencyLimit)
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
              rateLimit: body.options.queue.rateLimit,
            },
          });
        } else {
          taskQueue = await prisma.taskQueue.create({
            data: {
              friendlyId: generateFriendlyId("queue"),
              name: queueName,
              concurrencyLimit,
              runtimeEnvironmentId: environment.id,
              projectId: environment.projectId,
              rateLimit: body.options.queue.rateLimit,
              type: "NAMED",
            },
          });
        }

        if (typeof taskQueue.concurrencyLimit === "number") {
          await marqs?.updateQueueConcurrencyLimits(
            environment,
            taskQueue.name,
            taskQueue.concurrencyLimit
          );
        } else {
          await marqs?.removeQueueConcurrencyLimits(environment, taskQueue.name);
        }
      }

      if (taskRun.delayUntil) {
        //todo create an additional WaitPoint

        await workerQueue.enqueue(
          "v3.enqueueDelayedRun",
          { runId: taskRun.id },
          { tx, runAt: delayUntil, jobKey: `v3.enqueueDelayedRun.${taskRun.id}` }
        );
      }

      if (!taskRun.delayUntil && taskRun.ttl) {
        const expireAt = parseNaturalLanguageDuration(taskRun.ttl);

        if (expireAt) {
          await workerQueue.enqueue(
            "v3.expireRun",
            { runId: taskRun.id },
            { tx, runAt: expireAt, jobKey: `v3.expireRun.${taskRun.id}` }
          );
        }
      }
    });

    return taskRun;
    //todo waitpoints
    //todo enqueue
    //todo release concurrency?
  }

  /** Triggers multiple runs.
   * This doesn't start execution, but it will create a batch and schedule them for execution.
   */
  async batchTrigger() {}

  /** The run can be added to the queue. When it's pulled from the queue it will be executed. */
  async prepareForQueue(runId: string) {}

  /** We want to actually execute the run, this could be a continuation of a previous execution.
   * This is called from the queue, when the run has been pulled. */
  //todo think more about this, when do we create the attempt?
  //todo what does this actually do?
  //todo how does it get sent to the worker? DEV and PROD
  async prepareForExecution(runId: string) {}

  async prepareForAttempt(runId: string) {}

  async complete(runId: string, completion: any) {}
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
