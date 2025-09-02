import {
  createRedisClient,
  type Callback,
  type Redis,
  type RedisOptions,
  type Result,
} from "@internal/redis";
import {
  Attributes,
  context,
  getMeter,
  Meter,
  ObservableResult,
  propagation,
  SEMATTRS_MESSAGE_ID,
  SEMATTRS_MESSAGING_OPERATION,
  SEMATTRS_MESSAGING_SYSTEM,
  Span,
  SpanKind,
  SpanOptions,
  Tracer,
  ValueType,
} from "@internal/tracing";
import { promiseWithResolvers, tryCatch } from "@trigger.dev/core";
import { Logger, LogLevel } from "@trigger.dev/core/logger";
import { calculateNextRetryDelay, flattenAttributes } from "@trigger.dev/core/v3";
import { type RetryOptions } from "@trigger.dev/core/v3/schemas";
import { Decimal } from "@trigger.dev/database";
import { CronSchema, Worker, type WorkerConcurrencyOptions } from "@trigger.dev/redis-worker";
import { nanoid } from "nanoid";
import { Readable } from "node:stream";
import { setInterval, setTimeout } from "node:timers/promises";
import { z } from "zod";
import {
  attributesFromAuthenticatedEnv,
  MinimalAuthenticatedEnvironment,
} from "../shared/index.js";
import {
  InputPayload,
  OutputPayload,
  OutputPayloadV2,
  RunQueueKeyProducer,
  RunQueueSelectionStrategy,
} from "./types.js";

const SemanticAttributes = {
  QUEUE: "runqueue.queue",
  WORKER_QUEUE: "runqueue.workerQueue",
  MASTER_QUEUE_SHARD: "runqueue.masterQueueShard",
  CONSUMER_ID: "runqueue.consumerId",
  RUN_ID: "runqueue.runId",
  RESULT_COUNT: "runqueue.resultCount",
  CONCURRENCY_KEY: "runqueue.concurrencyKey",
  ORG_ID: "runqueue.orgId",
};

export type RunQueueOptions = {
  name: string;
  tracer: Tracer;
  redis: RedisOptions;
  defaultEnvConcurrency: number;
  defaultEnvConcurrencyBurstFactor?: number;
  windowSize?: number;
  keys: RunQueueKeyProducer;
  queueSelectionStrategy: RunQueueSelectionStrategy;
  verbose?: boolean;
  logger?: Logger;
  logLevel?: LogLevel;
  retryOptions?: RetryOptions;
  shardCount?: number;
  masterQueueConsumersDisabled?: boolean;
  masterQueueConsumersIntervalMs?: number;
  masterQueueCooloffPeriodMs?: number;
  masterQueueCooloffCountThreshold?: number;
  masterQueueConsumerDequeueCount?: number;
  processWorkerQueueDebounceMs?: number;
  workerOptions?: {
    pollIntervalMs?: number;
    immediatePollIntervalMs?: number;
    shutdownTimeoutMs?: number;
    concurrency?: WorkerConcurrencyOptions;
    disabled?: boolean;
  };
  meter?: Meter;
  dequeueBlockingTimeoutSeconds?: number;
  concurrencySweeper?: {
    scanSchedule?: string;
    scanJitterInMs?: number;
    processMarkedSchedule?: string;
    processMarkedJitterInMs?: number;
    callback: ConcurrencySweeperCallback;
  };
};

export interface ConcurrencySweeperCallback {
  (runIds: string[]): Promise<Array<{ id: string; orgId: string }>>;
}

type DequeuedMessage = {
  messageId: string;
  messageScore: string;
  message: OutputPayload;
  workerQueueLength?: number;
};

type MarkedRun = {
  orgId: string;
  messageId: string;
  score: number;
};

const defaultRetrySettings = {
  maxAttempts: 12,
  factor: 2,
  minTimeoutInMs: 1_000,
  maxTimeoutInMs: 3_600_000,
  randomize: true,
};

const workerCatalog = {
  processQueueForWorkerQueue: {
    schema: z.object({
      queueKey: z.string(),
      environmentId: z.string(),
    }),
    visibilityTimeoutMs: 30_000,
  },
  scanConcurrencySets: {
    schema: CronSchema,
    visibilityTimeoutMs: 60_000 * 5,
    cron: "*/10 * * * *",
    jitterInMs: 60_000,
    retry: {
      maxAttempts: 1,
    },
  },
  processMarkedRuns: {
    schema: CronSchema,
    visibilityTimeoutMs: 60_000 * 5,
    cron: "*/5 * * * *",
    jitterInMs: 30_000,
    retry: {
      maxAttempts: 1,
    },
  },
};

type QueueCooloffState =
  | {
      _tag: "normal";
      consecutiveFailures: number;
    }
  | {
      _tag: "cooloff";
      cooloffExpiresAt: number;
    };

/**
 * RunQueue – the queue that's used to process runs
 */
export class RunQueue {
  private retryOptions: RetryOptions;
  private subscriber: Redis;
  private luaDebugSubscriber: Redis;
  private logger: Logger;
  public redis: Redis;
  public keys: RunQueueKeyProducer;
  private queueSelectionStrategy: RunQueueSelectionStrategy;
  private shardCount: number;
  private abortController: AbortController;
  private worker: Worker<typeof workerCatalog>;
  private _observableWorkerQueues: Set<string> = new Set();
  private _meter: Meter;
  private _queueCooloffStates: Map<string, QueueCooloffState> = new Map();

  constructor(public readonly options: RunQueueOptions) {
    this.shardCount = options.shardCount ?? 2;
    this.retryOptions = options.retryOptions ?? defaultRetrySettings;
    this.redis = createRedisClient(options.redis, {
      onError: (error) => {
        this.logger.error(`RunQueue redis client error:`, {
          error,
          keyPrefix: options.redis.keyPrefix,
        });
      },
    });
    this.logger = options.logger ?? new Logger("RunQueue", options.logLevel ?? "info");
    this._meter = options.meter ?? getMeter("run-queue");

    const workerQueueObservableGauge = this._meter.createObservableGauge(
      "runqueue.workerQueue.length",
      {
        description: "The number of messages in the worker queue",
        unit: "messages",
        valueType: ValueType.INT,
      }
    );

    const masterQueueObservableGauge = this._meter.createObservableGauge(
      "runqueue.masterQueue.length",
      {
        description: "The number of queues in the master queue shard",
        unit: "queues",
        valueType: ValueType.INT,
      }
    );

    workerQueueObservableGauge.addCallback(this.#updateWorkerQueueLength.bind(this));
    masterQueueObservableGauge.addCallback(this.#updateMasterQueueLength.bind(this));

    this.abortController = new AbortController();

    this.keys = options.keys;
    this.queueSelectionStrategy = options.queueSelectionStrategy;

    this.subscriber = this.redis.duplicate();
    this.luaDebugSubscriber = this.redis.duplicate();

    this.worker = new Worker({
      name: "run-queue-worker",
      redisOptions: {
        ...options.redis,
        keyPrefix: `${options.redis.keyPrefix}:worker`,
      },
      catalog: {
        ...workerCatalog,
        scanConcurrencySets: {
          ...workerCatalog.scanConcurrencySets,
          cron: options.concurrencySweeper?.scanSchedule ?? workerCatalog.scanConcurrencySets.cron,
          jitterInMs:
            options.concurrencySweeper?.scanJitterInMs ??
            workerCatalog.scanConcurrencySets.jitterInMs,
        },
        processMarkedRuns: {
          ...workerCatalog.processMarkedRuns,
          cron:
            options.concurrencySweeper?.processMarkedSchedule ??
            workerCatalog.processMarkedRuns.cron,
          jitterInMs:
            options.concurrencySweeper?.processMarkedJitterInMs ??
            workerCatalog.processMarkedRuns.jitterInMs,
        },
      },
      concurrency: options.workerOptions?.concurrency,
      pollIntervalMs: options.workerOptions?.pollIntervalMs ?? 1000,
      immediatePollIntervalMs: options.workerOptions?.immediatePollIntervalMs ?? 100,
      shutdownTimeoutMs: options.workerOptions?.shutdownTimeoutMs ?? 10_000,
      logger: new Logger("RunQueueWorker", options.logLevel ?? "info"),
      jobs: {
        processQueueForWorkerQueue: async (job) => {
          await this.#processQueueForWorkerQueue(job.payload.queueKey, job.payload.environmentId);
        },
        scanConcurrencySets: async (job) => {
          await this.scanConcurrencySets();
        },
        processMarkedRuns: async (job) => {
          await this.processMarkedRuns();
        },
      },
    });

    if (!options.workerOptions?.disabled) {
      this.worker.start();
    }

    this.#setupSubscriber();
    this.#setupLuaLogSubscriber();
    this.#startMasterQueueConsumers();
    this.#registerCommands();
  }

  get name() {
    return this.options.name;
  }

  get tracer() {
    return this.options.tracer;
  }

  get meter() {
    return this._meter;
  }

  public async registerObservableWorkerQueue(workerQueue: string) {
    this._observableWorkerQueues.add(workerQueue);
  }

  async #updateWorkerQueueLength(observableResult: ObservableResult<Attributes>) {
    for (const workerQueue of this._observableWorkerQueues) {
      const workerQueueLength = await this.redis.llen(this.keys.workerQueueKey(workerQueue));

      observableResult.observe(workerQueueLength, {
        [SemanticAttributes.WORKER_QUEUE]: workerQueue,
      });
    }
  }

  async #updateMasterQueueLength(observableResult: ObservableResult<Attributes>) {
    for (let shard = 0; shard < this.shardCount; shard++) {
      const masterQueueKey = this.keys.masterQueueKeyForShard(shard);
      const masterQueueLength = await this.redis.zcard(masterQueueKey);

      observableResult.observe(masterQueueLength, {
        [SemanticAttributes.MASTER_QUEUE_SHARD]: shard.toString(),
      });
    }
  }

  public async updateQueueConcurrencyLimits(
    env: MinimalAuthenticatedEnvironment,
    queue: string,
    concurrency: number
  ) {
    return this.redis.set(this.keys.queueConcurrencyLimitKey(env, queue), concurrency);
  }

  public async removeQueueConcurrencyLimits(env: MinimalAuthenticatedEnvironment, queue: string) {
    return this.redis.del(this.keys.queueConcurrencyLimitKey(env, queue));
  }

  public async getQueueConcurrencyLimit(env: MinimalAuthenticatedEnvironment, queue: string) {
    const result = await this.redis.get(this.keys.queueConcurrencyLimitKey(env, queue));

    return result ? Number(result) : undefined;
  }

  public async updateEnvConcurrencyLimits(env: MinimalAuthenticatedEnvironment) {
    await this.#callUpdateEnvironmentConcurrencyLimits({
      envConcurrencyLimitKey: this.keys.envConcurrencyLimitKey(env),
      envConcurrencyLimit: env.maximumConcurrencyLimit,
      envConcurrencyLimitBurstFactorKey: this.keys.envConcurrencyLimitBurstFactorKey(env),
      envConcurrencyLimitBurstFactor: env.concurrencyLimitBurstFactor.toString(),
    });
  }

  public async getEnvConcurrencyLimit(env: MinimalAuthenticatedEnvironment) {
    const result = await this.redis.get(this.keys.envConcurrencyLimitKey(env));

    return result ? Number(result) : this.options.defaultEnvConcurrency;
  }

  public async getEnvConcurrencyLimitWithBurstFactor(env: MinimalAuthenticatedEnvironment) {
    const result = await this.redis.get(this.keys.envConcurrencyLimitBurstFactorKey(env));

    const burstFactor = result
      ? Number(result)
      : this.options.defaultEnvConcurrencyBurstFactor ?? 1;

    const limit = await this.getEnvConcurrencyLimit(env);

    return Math.floor(limit * burstFactor);
  }

  public async lengthOfQueue(
    env: MinimalAuthenticatedEnvironment,
    queue: string,
    concurrencyKey?: string
  ) {
    return this.redis.zcard(this.keys.queueKey(env, queue, concurrencyKey));
  }

  public async lengthOfEnvQueue(env: MinimalAuthenticatedEnvironment) {
    return this.redis.zcard(this.keys.envQueueKey(env));
  }

  public async lengthOfDeadLetterQueue(env: MinimalAuthenticatedEnvironment) {
    return this.redis.zcard(this.keys.deadLetterQueueKey(env));
  }

  public async messageInDeadLetterQueue(env: MinimalAuthenticatedEnvironment, messageId: string) {
    const result = await this.redis.zscore(this.keys.deadLetterQueueKey(env), messageId);
    return !!result;
  }

  public async redriveMessage(env: MinimalAuthenticatedEnvironment, messageId: string) {
    // Publish redrive message
    await this.redis.publish(
      "rq:redrive",
      JSON.stringify({
        runId: messageId,
        orgId: env.organization.id,
        envId: env.id,
        projectId: env.project.id,
      })
    );
  }

  public async oldestMessageInQueue(
    env: MinimalAuthenticatedEnvironment,
    queue: string,
    concurrencyKey?: string
  ) {
    // Get the "score" of the sorted set to get the oldest message score
    const result = await this.redis.zrange(
      this.keys.queueKey(env, queue, concurrencyKey),
      0,
      0,
      "WITHSCORES"
    );

    if (result.length === 0) {
      return;
    }

    const score = Number(result[1]);

    return score;
  }

  public async currentConcurrencyOfQueue(
    env: MinimalAuthenticatedEnvironment,
    queue: string,
    concurrencyKey?: string
  ) {
    return this.redis.scard(this.keys.queueCurrentConcurrencyKey(env, queue, concurrencyKey));
  }

  public async currentConcurrencyOfQueues(
    env: MinimalAuthenticatedEnvironment,
    queues: string[]
  ): Promise<Record<string, number>> {
    const pipeline = this.redis.pipeline();

    // Queue up all SCARD commands in the pipeline
    queues.forEach((queue) => {
      pipeline.scard(this.keys.queueCurrentDequeuedKey(env, queue));
    });

    // Execute pipeline and get results
    const results = await pipeline.exec();

    // If results is null, return all queues with 0 concurrency
    if (!results) {
      return queues.reduce(
        (acc, queue) => {
          acc[queue] = 0;
          return acc;
        },
        {} as Record<string, number>
      );
    }

    // Map results back to queue names, handling potential errors
    return queues.reduce(
      (acc, queue, index) => {
        const [err, value] = results[index];
        // If there was an error or value is null/undefined, use 0
        acc[queue] = err || value == null ? 0 : (value as number);
        return acc;
      },
      {} as Record<string, number>
    );
  }

  public async lengthOfQueues(
    env: MinimalAuthenticatedEnvironment,
    queues: string[]
  ): Promise<Record<string, number>> {
    const pipeline = this.redis.pipeline();

    // Queue up all ZCARD commands in the pipeline
    queues.forEach((queue) => {
      pipeline.zcard(this.keys.queueKey(env, queue));
    });

    const results = await pipeline.exec();

    if (!results) {
      return queues.reduce(
        (acc, queue) => {
          acc[queue] = 0;
          return acc;
        },
        {} as Record<string, number>
      );
    }

    return queues.reduce(
      (acc, queue, index) => {
        const [err, value] = results![index];
        acc[queue] = err || value == null ? 0 : (value as number);
        return acc;
      },
      {} as Record<string, number>
    );
  }

  /**
   * Get the current concurrency of the environment
   * @param env - The environment to get the current concurrency of
   * @returns The current concurrency of the environment
   */
  public async currentConcurrencyOfEnvironment(env: MinimalAuthenticatedEnvironment) {
    // We are now using the envCurrentDequeuedKey to track the current "displayed" concurrency of the environment
    // Operationally, we use the envCurrentConcurrencyKey to track the actual concurrency of the environment
    // The currentDequeuedKey is incremented when a message is dequeued from the worker queue,
    // wherease the currentConcurrencyKey is incremented when a message is dequeued from the message queue and put into the worker queue
    return this.redis.scard(this.keys.envCurrentDequeuedKey(env));
  }

  public async messageExists(orgId: string, messageId: string) {
    return this.redis.exists(this.keys.messageKey(orgId, messageId));
  }

  public async readMessage(orgId: string, messageId: string) {
    return this.readMessageFromKey(this.keys.messageKey(orgId, messageId));
  }

  public async readMessageFromKey(messageKey: string) {
    return this.#trace(
      "readMessageFromKey",
      async (span) => {
        const rawMessage = await this.redis.get(messageKey);

        if (!rawMessage) {
          return;
        }

        const [error, message] = parseRawMessage(rawMessage);

        if (error) {
          this.logger.error(`[${this.name}] Failed to parse message`, {
            messageKey,
            error,
            service: this.name,
            message: message ?? rawMessage,
          });
        }

        if (message) {
          span.setAttributes({
            [SemanticAttributes.QUEUE]: message.queue,
            [SemanticAttributes.RUN_ID]: message.runId,
            [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
            [SemanticAttributes.WORKER_QUEUE]: this.#getWorkerQueueFromMessage(message),
          });
        }

        return message;
      },
      {
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "receive",
          [SEMATTRS_MESSAGING_SYSTEM]: "runqueue",
        },
      }
    );
  }

  public async enqueueMessage({
    env,
    message,
    workerQueue,
    skipDequeueProcessing = false,
  }: {
    env: MinimalAuthenticatedEnvironment;
    message: InputPayload;
    workerQueue: string;
    skipDequeueProcessing?: boolean;
  }) {
    return await this.#trace(
      "enqueueMessage",
      async (span) => {
        const { runId, concurrencyKey } = message;

        const queueKey = this.keys.queueKey(env, message.queue, concurrencyKey);

        propagation.inject(context.active(), message);

        span.setAttributes({
          [SemanticAttributes.QUEUE]: queueKey,
          [SemanticAttributes.RUN_ID]: runId,
          [SemanticAttributes.CONCURRENCY_KEY]: concurrencyKey,
          [SemanticAttributes.WORKER_QUEUE]: workerQueue,
        });

        const messagePayload: OutputPayloadV2 = {
          ...message,
          version: "2",
          queue: queueKey,
          workerQueue,
          attempt: 0,
        };

        if (!skipDequeueProcessing) {
          // This will move the message to the worker queue so it can be dequeued
          await this.worker.enqueueOnce({
            id: queueKey, // dedupe by environment, queue, and concurrency key
            job: "processQueueForWorkerQueue",
            payload: {
              queueKey,
              environmentId: env.id,
            },
            // Add a small delay to dedupe messages so at most one of these will processed,
            // every 500ms per queue, concurrency key, and environment
            availableAt: new Date(Date.now() + (this.options.processWorkerQueueDebounceMs ?? 500)), // 500ms from now
          });
        }

        return await this.#callEnqueueMessage(messagePayload);
      },
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "publish",
          [SEMATTRS_MESSAGE_ID]: message.runId,
          [SEMATTRS_MESSAGING_SYSTEM]: "runqueue",
          ...attributesFromAuthenticatedEnv(env),
        },
      }
    );
  }

  /**
   * Dequeue messages from the worker queue
   */
  public async dequeueMessageFromWorkerQueue(
    consumerId: string,
    workerQueue: string,
    options?: {
      blockingPop?: boolean;
      blockingPopTimeoutSeconds?: number;
    }
  ): Promise<DequeuedMessage | undefined> {
    return this.#trace(
      "dequeueMessageFromWorkerQueue",
      async (span) => {
        const dequeuedMessage = await this.#callDequeueMessageFromWorkerQueue({
          workerQueue,
          blockingPop: options?.blockingPop ?? true,
          blockingPopTimeoutSeconds:
            options?.blockingPopTimeoutSeconds ?? this.options.dequeueBlockingTimeoutSeconds ?? 10,
        });

        if (!dequeuedMessage) {
          return;
        }

        span.setAttributes({
          [SemanticAttributes.QUEUE]: dequeuedMessage.message.queue,
          [SemanticAttributes.RUN_ID]: dequeuedMessage.messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: dequeuedMessage.message.concurrencyKey,
          ...flattenAttributes(dequeuedMessage.message, "message"),
        });

        return dequeuedMessage;
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "receive",
          [SEMATTRS_MESSAGING_SYSTEM]: "runqueue",
          [SemanticAttributes.WORKER_QUEUE]: workerQueue,
          [SemanticAttributes.CONSUMER_ID]: consumerId,
        },
      }
    );
  }

  /**
   * Acknowledge a message, which will:
   * - remove all data from the queue
   * - release all concurrency
   * This is done when the run is in a final state.
   * @param messageId
   */
  public async acknowledgeMessage(
    orgId: string,
    messageId: string,
    options?: { skipDequeueProcessing?: boolean; removeFromWorkerQueue?: boolean }
  ) {
    return this.#trace(
      "acknowledgeMessage",
      async (span) => {
        const message = await this.readMessage(orgId, messageId);

        if (!message) {
          // Message not found, it may have already been acknowledged
          return;
        }

        span.setAttributes({
          [SemanticAttributes.QUEUE]: message.queue,
          [SemanticAttributes.ORG_ID]: message.orgId,
          [SemanticAttributes.RUN_ID]: messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
        });

        if (!options?.skipDequeueProcessing) {
          // This will move the message to the worker queue so it can be dequeued
          await this.worker.enqueueOnce({
            id: message.queue, // dedupe by environment, queue, and concurrency key
            job: "processQueueForWorkerQueue",
            payload: {
              queueKey: message.queue,
              environmentId: message.environmentId,
            },
            // Add a small delay to dedupe messages so at most one of these will processed,
            // every 500ms per queue, concurrency key, and environment
            availableAt: new Date(Date.now() + (this.options.processWorkerQueueDebounceMs ?? 500)), // 500ms from now
          });
        }

        await this.#callAcknowledgeMessage({
          message,
          removeFromWorkerQueue: options?.removeFromWorkerQueue,
        });
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "ack",
          [SEMATTRS_MESSAGE_ID]: messageId,
          [SEMATTRS_MESSAGING_SYSTEM]: "runqueue",
        },
      }
    );
  }

  /**
   * Negative acknowledge a message, which will requeue the message (with an optional future date).
    If you pass no date it will get reattempted with exponential backoff.
   */
  public async nackMessage({
    orgId,
    messageId,
    retryAt,
    incrementAttemptCount = true,
    skipDequeueProcessing = false,
  }: {
    orgId: string;
    messageId: string;
    retryAt?: number;
    incrementAttemptCount?: boolean;
    skipDequeueProcessing?: boolean;
  }) {
    return this.#trace(
      "nackMessage",
      async (span) => {
        const maxAttempts = this.retryOptions.maxAttempts ?? defaultRetrySettings.maxAttempts;

        const message = await this.readMessage(orgId, messageId);
        if (!message) {
          this.logger.log(`[${this.name}].nackMessage() message not found`, {
            orgId,
            messageId,
            maxAttempts,
            retryAt,
            service: this.name,
          });
          return;
        }

        span.setAttributes({
          [SemanticAttributes.QUEUE]: message.queue,
          [SemanticAttributes.RUN_ID]: messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
          [SemanticAttributes.WORKER_QUEUE]: this.#getWorkerQueueFromMessage(message),
        });

        if (incrementAttemptCount) {
          message.attempt = message.attempt + 1;
          if (message.attempt >= maxAttempts) {
            await this.#callMoveToDeadLetterQueue({ message });
            return false;
          }
        }

        if (!skipDequeueProcessing) {
          // This will move the message to the worker queue so it can be dequeued
          await this.worker.enqueueOnce({
            id: message.queue, // dedupe by environment, queue, and concurrency key
            job: "processQueueForWorkerQueue",
            payload: {
              queueKey: message.queue,
              environmentId: message.environmentId,
            },
            // Add a small delay to dedupe messages so at most one of these will processed,
            // every 500ms per queue, concurrency key, and environment
            availableAt: new Date(Date.now() + (this.options.processWorkerQueueDebounceMs ?? 500)), // 500ms from now
          });
        }

        await this.#callNackMessage({ message, retryAt });

        return true;
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "nack",
          [SEMATTRS_MESSAGE_ID]: messageId,
          [SEMATTRS_MESSAGING_SYSTEM]: "runqueue",
        },
      }
    );
  }

  /**
   * Release all concurrency for a message, including environment and queue concurrency
   */
  public async releaseAllConcurrency(orgId: string, messageId: string) {
    return this.#trace(
      "releaseAllConcurrency",
      async (span) => {
        const message = await this.readMessage(orgId, messageId);

        if (!message) {
          this.logger.log(`[${this.name}].releaseAllConcurrency() message not found`, {
            messageId,
            service: this.name,
          });
          return;
        }

        span.setAttributes({
          [SemanticAttributes.QUEUE]: message.queue,
          [SemanticAttributes.ORG_ID]: message.orgId,
          [SemanticAttributes.RUN_ID]: messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
        });

        return this.redis.releaseConcurrency(
          this.keys.queueCurrentConcurrencyKeyFromQueue(message.queue),
          this.keys.envCurrentConcurrencyKeyFromQueue(message.queue),
          this.keys.queueCurrentDequeuedKeyFromQueue(message.queue),
          this.keys.envCurrentDequeuedKeyFromQueue(message.queue),
          messageId
        );
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "releaseAllConcurrency",
          [SEMATTRS_MESSAGE_ID]: messageId,
          [SEMATTRS_MESSAGING_SYSTEM]: "runqueue",
        },
      }
    );
  }

  public async removeEnvironmentQueuesFromMasterQueue(
    runtimeEnvironmentId: string,
    organizationId: string,
    projectId: string
  ) {
    // Calculate the master queue shard for this environment
    const masterQueue = this.keys.masterQueueKeyForEnvironment(
      runtimeEnvironmentId,
      this.shardCount
    );

    // Use scanStream to find all matching members
    const stream = this.redis.zscanStream(masterQueue, {
      match: this.keys.queueKey(organizationId, projectId, "*", "*"),
      count: 100,
    });

    return new Promise<void>((resolve, reject) => {
      const matchingQueues: string[] = [];

      stream.on("data", (resultKeys) => {
        // zscanStream returns [member1, score1, member2, score2, ...]
        // We only want the members (even indices)
        for (let i = 0; i < resultKeys.length; i += 2) {
          matchingQueues.push(resultKeys[i]);
        }
      });

      stream.on("end", async () => {
        if (matchingQueues.length > 0) {
          await this.redis.zrem(masterQueue, matchingQueues);
        }
        resolve();
      });

      stream.on("error", (err) => reject(err));
    });
  }

  async quit() {
    this.abortController.abort();

    await Promise.all([
      this.subscriber.unsubscribe(),
      this.luaDebugSubscriber.unsubscribe(),
      this.subscriber.quit(),
      this.luaDebugSubscriber.quit(),
      this.worker.stop(),
    ]);

    await this.redis.quit();
  }

  /**
   * Peek all messages on a worker queue (useful for tests or debugging)
   */
  async peekAllOnWorkerQueue(workerQueue: string) {
    const workerQueueKey = this.keys.workerQueueKey(workerQueue);
    return await this.redis.lrange(workerQueueKey, 0, -1);
  }

  /**
   * Create a scan stream for queue current concurrency keys
   */
  public currentConcurrencyScanStream(
    count: number = 10,
    onEnd?: () => void,
    onError?: (error: Error) => void
  ): { stream: Readable; redis: Redis } {
    const pattern = this.keys.currentConcurrencySetKeyScanPattern();
    const stream = this.redis.scanStream({
      match: pattern,
      count,
      type: "set",
    });

    if (onEnd) {
      stream.on("end", onEnd);
    }

    if (onError) {
      stream.on("error", onError);
    }

    return {
      stream,
      redis: this.redis,
    };
  }

  private async handleRedriveMessage(channel: string, message: string) {
    try {
      const { runId, envId, projectId, orgId } = JSON.parse(message) as any;
      if (
        typeof orgId !== "string" ||
        typeof runId !== "string" ||
        typeof envId !== "string" ||
        typeof projectId !== "string"
      ) {
        this.logger.error(
          "handleRedriveMessage: invalid message format: runId, envId, projectId and orgId must be strings",
          { message, channel }
        );
        return;
      }

      const data = await this.readMessage(orgId, runId);

      if (!data) {
        this.logger.error(`handleRedriveMessage: couldn't read message`, { orgId, runId, channel });
        return;
      }

      await this.enqueueMessage({
        env: {
          id: data.environmentId,
          type: data.environmentType,
          //this isn't used in enqueueMessage
          maximumConcurrencyLimit: -1,
          concurrencyLimitBurstFactor: new Decimal(1.0),
          project: {
            id: data.projectId,
          },
          organization: {
            id: data.orgId,
          },
        },
        message: {
          ...data,
          attempt: 0,
        },
        workerQueue: this.#getWorkerQueueFromMessage(data),
      });

      //remove from the dlq
      const result = await this.redis.zrem(
        this.keys.deadLetterQueueKey({ envId, orgId, projectId }),
        runId
      );

      if (result === 0) {
        this.logger.error(`handleRedriveMessage: couldn't remove message from dlq`, {
          orgId,
          runId,
          channel,
        });
        return;
      }

      this.logger.log(`handleRedriveMessage: redrived item ${runId} from Dead Letter Queue`);
    } catch (error) {
      this.logger.error("Error processing redrive message", { error, message });
    }
  }

  async #trace<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    options?: SpanOptions & { sampleRate?: number }
  ): Promise<T> {
    return this.tracer.startActiveSpan(
      name,
      {
        ...options,
        attributes: {
          ...options?.attributes,
        },
      },
      async (span) => {
        try {
          return await fn(span);
        } catch (e) {
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

  async #setupSubscriber() {
    const channel = `${this.options.name}:redrive`;
    this.subscriber.subscribe(channel, (err) => {
      if (err) {
        this.logger.error(`Failed to subscribe to ${channel}`, { error: err });
      } else {
        this.logger.log(`Subscribed to ${channel}`);
      }
    });

    this.subscriber.on("message", this.handleRedriveMessage.bind(this));
  }

  /**
   * Debug lua scripts by publishing to this channel
   *
   * @example
   *
   * ```lua
   * redis.call("PUBLISH", "runqueue:lua:debug", "workerQueueKey: " .. workerQueueKey .. " messageKeyValue -> " .. tostring(messageKeyValue))
   * ```
   */
  async #setupLuaLogSubscriber() {
    this.luaDebugSubscriber.subscribe("runqueue:lua:debug", (err) => {
      if (err) {
        this.logger.error(`Failed to subscribe to runqueue:lua:debug`, { error: err });
      } else {
        this.logger.log(`Subscribed to runqueue:lua:debug`);
      }
    });

    this.luaDebugSubscriber.on("message", (_channel, msg) => {
      this.logger.debug("runqueue lua debug", { msg });
    });
  }

  #startMasterQueueConsumers() {
    if (this.options.masterQueueConsumersDisabled) {
      this.logger.debug("Master queue consumers disabled");

      return;
    }

    for (let i = 0; i < this.shardCount; i++) {
      this.logger.debug(`Starting master queue consumer ${i}`);
      // We will start a consumer for each shard
      this.#startMasterQueueConsumer(i).catch((err) => {
        this.logger.error(`Failed to start master queue consumer ${i}`, { error: err });
      });
    }

    this.logger.debug(`Started ${this.shardCount} master queue consumers`);
  }

  async #startMasterQueueConsumer(shard: number) {
    let lastProcessedAt = Date.now();
    let processedCount = 0;

    const consumerId = nanoid();

    try {
      for await (const _ of setInterval(this.options.masterQueueConsumersIntervalMs ?? 500, null, {
        signal: this.abortController.signal,
      })) {
        this.logger.verbose(`Processing master queue shard ${shard}`, {
          processedCount,
          lastProcessedAt,
          service: this.name,
          shard,
          consumerId,
        });

        const now = performance.now();

        const [error, results] = await tryCatch(
          this.#processMasterQueueShard(
            shard,
            consumerId,
            this.options.masterQueueConsumerDequeueCount ?? 10
          )
        );

        if (error) {
          this.logger.error(`Failed to process master queue shard ${shard}`, {
            error,
            service: this.name,
            shard,
            consumerId,
          });

          continue;
        }

        const duration = performance.now() - now;

        this.logger.verbose(`Processed master queue shard ${shard} in ${duration}ms`, {
          processedCount,
          lastProcessedAt,
          service: this.name,
          shard,
          duration,
          results,
          consumerId,
        });

        processedCount++;
        lastProcessedAt = Date.now();
      }
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        throw error;
      }

      this.logger.debug(`Master queue consumer ${shard} stopped`, {
        service: this.name,
        shard,
        processedCount,
        lastProcessedAt,
      });
    }
  }

  async migrateLegacyMasterQueue(legacyMasterQueue: string) {
    const legacyMasterQueueKey = this.keys.legacyMasterQueueKey(legacyMasterQueue);

    this.logger.debug("Migrating legacy master queue", {
      legacyMasterQueueKey,
      service: this.name,
    });

    // Get all items from the legacy master queue
    const queueNames = await this.redis.zrange(legacyMasterQueueKey, 0, -1);

    this.logger.debug("Found items in legacy master queue", {
      queueNames,
      service: this.name,
    });

    // We need to group the items by the new masterQueueKey, so we need to extract out the environmentId from the queue name and calculate the shard
    const queuesByMasterQueueKey = new Map<string, string[]>();

    for (const queueName of queueNames) {
      const environmentId = this.keys.envIdFromQueue(queueName);
      const shard = this.keys.masterQueueShardForEnvironment(environmentId, this.shardCount);
      const masterQueueKey = this.keys.masterQueueKeyForShard(shard);
      queuesByMasterQueueKey.set(masterQueueKey, [
        ...(queuesByMasterQueueKey.get(masterQueueKey) ?? []),
        queueName,
      ]);
    }

    this.logger.debug("Grouping items by new master queue key", {
      queuesByMasterQueueKey: Object.fromEntries(queuesByMasterQueueKey.entries()),
      service: this.name,
    });

    const pipeline = this.redis.pipeline();

    for (const [masterQueueKey, queueNames] of queuesByMasterQueueKey) {
      pipeline.migrateLegacyMasterQueues(
        masterQueueKey,
        this.options.redis.keyPrefix ?? "",
        ...queueNames
      );
    }

    await pipeline.exec();

    this.logger.debug("Migrated legacy master queue", {
      legacyMasterQueueKey,
      service: this.name,
    });
  }

  // This is used for test purposes only
  async processMasterQueueForEnvironment(environmentId: string, maxCount: number = 10) {
    const shard = this.keys.masterQueueShardForEnvironment(environmentId, this.shardCount);

    return this.#processMasterQueueShard(shard, environmentId, maxCount);
  }

  async #processMasterQueueShard(shard: number, consumerId: string, maxCount: number = 10) {
    return this.#trace(
      "processMasterQueueShard",
      async (span) => {
        const masterQueueKey = this.keys.masterQueueKeyForShard(shard);

        const envQueues = await this.queueSelectionStrategy.distributeFairQueuesFromParentQueue(
          masterQueueKey,
          consumerId
        );

        span.setAttribute("master_queue_key", masterQueueKey);
        span.setAttribute("environment_count", envQueues.length);
        span.setAttribute("max_count", maxCount);

        if (envQueues.length === 0) {
          return [];
        }

        let attemptedEnvs = 0;
        let attemptedQueues = 0;
        let messagesDequeued = 0;
        let cooloffPeriodCount = 0;

        for (const env of envQueues) {
          attemptedEnvs++;

          for (const queue of env.queues) {
            const cooloffState = this._queueCooloffStates.get(queue) ?? {
              _tag: "normal",
              consecutiveFailures: 0,
            };

            if (cooloffState._tag === "cooloff") {
              if (cooloffState.cooloffExpiresAt > Date.now()) {
                cooloffPeriodCount++;
                continue;
              } else {
                this._queueCooloffStates.delete(queue);
              }
            }

            attemptedQueues++;

            // Attempt to dequeue from this queue
            const [error, messages] = await tryCatch(
              this.#callDequeueMessagesFromQueue({
                messageQueue: queue,
                shard,
                // TODO: make this configurable
                maxCount,
              })
            );

            if (error) {
              this.logger.error(
                `[processMasterQueueShard][${this.name}] Failed to dequeue from queue`,
                {
                  error,
                  queue,
                }
              );

              continue;
            }

            if (messages.length === 0) {
              if (cooloffState._tag === "normal") {
                const cooloffCountThreshold = Math.max(
                  1,
                  this.options.masterQueueCooloffCountThreshold ?? 10
                ); // Don't let the cooloff count be less than 1

                this.logger.debug("Evaluating cooloff state", {
                  queue,
                  cooloffState,
                  cooloffCountThreshold,
                  consecutiveFailures: cooloffState.consecutiveFailures,
                });

                if (cooloffState.consecutiveFailures >= cooloffCountThreshold) {
                  this.logger.debug("Setting cooloff state", {
                    queue,
                    cooloffState,
                    cooloffCountThreshold,
                    consecutiveFailures: cooloffState.consecutiveFailures,
                    cooloffExpiresAt: new Date(
                      Date.now() + (this.options.masterQueueCooloffPeriodMs ?? 10_000)
                    ),
                  });

                  this._queueCooloffStates.set(queue, {
                    _tag: "cooloff",
                    cooloffExpiresAt:
                      Date.now() + (this.options.masterQueueCooloffPeriodMs ?? 10_000),
                  });
                } else {
                  this._queueCooloffStates.set(queue, {
                    _tag: "normal",
                    consecutiveFailures: cooloffState.consecutiveFailures + 1,
                  });
                }
              }

              continue;
            }

            messagesDequeued += messages.length;

            await this.#enqueueMessagesToWorkerQueues(messages);
          }
        }

        span.setAttribute("attempted_envs", attemptedEnvs);
        span.setAttribute("attempted_queues", attemptedQueues);
        span.setAttribute("messages_dequeued", messagesDequeued);
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "receive",
          [SEMATTRS_MESSAGING_SYSTEM]: "runqueue",
        },
      }
    );
  }

  async #processQueueForWorkerQueue(queueKey: string, environmentId: string) {
    const shard = this.keys.masterQueueShardForEnvironment(environmentId, this.shardCount);

    this.logger.debug("processQueueForWorkerQueue", {
      queueKey,
      shard,
      service: this.name,
    });

    const messages = await this.#callDequeueMessagesFromQueue({
      messageQueue: queueKey,
      shard,
      maxCount: 10,
    });

    if (messages.length === 0) {
      return;
    }

    await this.#enqueueMessagesToWorkerQueues(messages);

    if (messages.length === 10) {
      await this.#processQueueForWorkerQueue(queueKey, environmentId);
    }
  }

  async #enqueueMessagesToWorkerQueues(messages: DequeuedMessage[]) {
    await this.#trace("enqueueMessagesToWorkerQueues", async (span) => {
      span.setAttribute("message_count", messages.length);

      const pipeline = this.redis.pipeline();

      const workerQueueKeys = new Set<string>();

      for (const message of messages) {
        const workerQueueKey = this.keys.workerQueueKey(
          this.#getWorkerQueueFromMessage(message.message)
        );

        workerQueueKeys.add(workerQueueKey);

        const messageKeyValue = this.keys.messageKey(message.message.orgId, message.messageId);

        pipeline.rpush(workerQueueKey, messageKeyValue);
      }

      span.setAttribute("worker_queue_count", workerQueueKeys.size);
      span.setAttribute("worker_queue_keys", Array.from(workerQueueKeys));

      this.logger.debug("enqueueMessagesToWorkerQueues pipeline", {
        service: this.name,
        messages,
        workerQueueKeys: Array.from(workerQueueKeys),
      });

      await pipeline.exec();
    });
  }

  async #callEnqueueMessage(message: OutputPayloadV2) {
    const queueKey = message.queue;
    const messageKey = this.keys.messageKey(message.orgId, message.runId);
    const queueCurrentConcurrencyKey = this.keys.queueCurrentConcurrencyKeyFromQueue(message.queue);
    const envCurrentConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
    const queueCurrentDequeuedKey = this.keys.queueCurrentDequeuedKeyFromQueue(message.queue);
    const envCurrentDequeuedKey = this.keys.envCurrentDequeuedKeyFromQueue(message.queue);
    const envQueueKey = this.keys.envQueueKeyFromQueue(message.queue);
    const masterQueueKey = this.keys.masterQueueKeyForEnvironment(
      message.environmentId,
      this.shardCount
    );

    const queueName = message.queue;
    const messageId = message.runId;
    const messageData = JSON.stringify(message);
    const messageScore = String(message.timestamp);

    this.logger.debug("Calling enqueueMessage", {
      queueKey,
      messageKey,
      queueCurrentConcurrencyKey,
      envCurrentConcurrencyKey,
      queueCurrentDequeuedKey,
      envCurrentDequeuedKey,
      envQueueKey,
      queueName,
      messageId,
      messageData,
      messageScore,
      masterQueueKey,
      service: this.name,
    });

    await this.redis.enqueueMessage(
      masterQueueKey,
      queueKey,
      messageKey,
      queueCurrentConcurrencyKey,
      envCurrentConcurrencyKey,
      queueCurrentDequeuedKey,
      envCurrentDequeuedKey,
      envQueueKey,
      queueName,
      messageId,
      messageData,
      messageScore
    );
  }

  async #callDequeueMessagesFromQueue({
    messageQueue,
    shard,
    maxCount,
  }: {
    messageQueue: string;
    shard: number;
    maxCount: number;
  }): Promise<DequeuedMessage[]> {
    return this.#trace("callDequeueMessagesFromQueue", async (span) => {
      span.setAttributes({
        messageQueue,
        shard,
        maxCount,
      });

      const queueConcurrencyLimitKey = this.keys.queueConcurrencyLimitKeyFromQueue(messageQueue);
      const queueCurrentConcurrencyKey =
        this.keys.queueCurrentConcurrencyKeyFromQueue(messageQueue);
      const envConcurrencyLimitKey = this.keys.envConcurrencyLimitKeyFromQueue(messageQueue);
      const envConcurrencyLimitBurstFactorKey =
        this.keys.envConcurrencyLimitBurstFactorKeyFromQueue(messageQueue);
      const envCurrentConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(messageQueue);
      const messageKeyPrefix = this.keys.messageKeyPrefixFromQueue(messageQueue);
      const envQueueKey = this.keys.envQueueKeyFromQueue(messageQueue);
      const masterQueueKey = this.keys.masterQueueKeyForShard(shard);

      this.logger.debug("#callDequeueMessagesFromQueue", {
        messageQueue,
        queueConcurrencyLimitKey,
        envConcurrencyLimitKey,
        envConcurrencyLimitBurstFactorKey,
        queueCurrentConcurrencyKey,
        envCurrentConcurrencyKey,
        messageKeyPrefix,
        envQueueKey,
        masterQueueKey,
        shard,
        maxCount,
      });

      const result = await this.redis.dequeueMessagesFromQueue(
        //keys
        messageQueue,
        queueConcurrencyLimitKey,
        envConcurrencyLimitKey,
        envConcurrencyLimitBurstFactorKey,
        queueCurrentConcurrencyKey,
        envCurrentConcurrencyKey,
        messageKeyPrefix,
        envQueueKey,
        masterQueueKey,
        //args
        messageQueue,
        String(Date.now()),
        String(this.options.defaultEnvConcurrency),
        String(this.options.defaultEnvConcurrencyBurstFactor ?? 1),
        this.options.redis.keyPrefix ?? "",
        String(maxCount)
      );

      if (!result) {
        span.setAttribute("message_count", 0);

        return [];
      }

      this.logger.debug("dequeueMessagesFromQueue raw result", {
        result,
        service: this.name,
      });

      const messages = [];
      for (let i = 0; i < result.length; i += 3) {
        const messageId = result[i];
        const messageScore = result[i + 1];
        const rawMessage = result[i + 2];

        //read message
        const parsedMessage = OutputPayload.safeParse(JSON.parse(rawMessage));
        if (!parsedMessage.success) {
          this.logger.error(`[${this.name}] Failed to parse message`, {
            messageId,
            error: parsedMessage.error,
            service: this.name,
          });

          continue;
        }

        const message = parsedMessage.data;

        messages.push({
          messageId,
          messageScore,
          message,
        });
      }

      this.logger.debug("dequeueMessagesFromQueue parsed result", {
        messages,
        service: this.name,
      });

      const filteredMessages = messages.filter(Boolean) as DequeuedMessage[];

      span.setAttribute("message_count", filteredMessages.length);

      return filteredMessages;
    });
  }

  async #callDequeueMessageFromWorkerQueue({
    workerQueue,
    blockingPop,
    blockingPopTimeoutSeconds,
  }: {
    workerQueue: string;
    blockingPop: boolean;
    blockingPopTimeoutSeconds: number;
  }): Promise<DequeuedMessage | undefined> {
    const workerQueueKey = this.keys.workerQueueKey(workerQueue);

    if (blockingPop) {
      this.logger.debug("#callDequeueMessageFromWorkerQueue blocking pop", {
        workerQueue,
        workerQueueKey,
        blockingPopTimeoutSeconds,
      });

      if (this.abortController.signal.aborted) {
        return;
      }

      const blockingClient = this.#createBlockingDequeueClient();

      async function cleanup() {
        await blockingClient.quit();
      }

      this.abortController.signal.addEventListener("abort", cleanup);

      const result = await this.#trace("popMessageFromWorkerQueue", async (span) => {
        span.setAttributes({
          workerQueue,
          workerQueueKey,
          blockingPopTimeoutSeconds,
          blocking: true,
        });

        return await blockingClient.blpop(workerQueueKey, blockingPopTimeoutSeconds);
      });

      this.abortController.signal.removeEventListener("abort", cleanup);

      cleanup().then(() => {
        this.logger.debug("dequeueMessageFromWorkerQueue cleanup", {
          service: this.name,
        });
      });

      if (!result) {
        return;
      }

      this.logger.debug("dequeueMessageFromWorkerQueue raw result", {
        result,
        service: this.name,
      });

      if (result.length !== 2) {
        this.logger.error("Invalid dequeue message from worker queue result", {
          result,
          service: this.name,
        });
        return;
      }

      // Make sure they are both strings
      if (typeof result[0] !== "string" || typeof result[1] !== "string") {
        this.logger.error("Invalid dequeue message from worker queue result", {
          result,
          service: this.name,
        });
        return;
      }

      const [, messageKey] = result;

      const workerQueueLength = await this.#trace("getWorkerQueueLength", async (span) => {
        span.setAttributes({
          workerQueue,
          workerQueueKey,
        });

        return await this.redis.llen(workerQueueKey);
      });

      const message = await this.#dequeueMessageFromKey(messageKey);

      if (!message) {
        return;
      }

      return {
        messageId: message.runId,
        messageScore: String(message.timestamp),
        message,
        workerQueueLength,
      };
    } else {
      this.logger.debug("#callDequeueMessageFromWorkerQueue non-blocking pop", {
        workerQueue,
        workerQueueKey,
      });

      const result = await this.#trace("popMessageFromWorkerQueue", async (span) => {
        span.setAttributes({
          workerQueue,
          workerQueueKey,
          blocking: false,
        });

        return await this.redis.dequeueMessageFromWorkerQueueNonBlocking(workerQueueKey);
      });

      if (!result) {
        return;
      }

      const [messageKey, workerQueueLength] = result;

      const message = await this.#dequeueMessageFromKey(messageKey);

      if (!message) {
        return;
      }

      return {
        messageId: message.runId,
        messageScore: String(message.timestamp),
        message,
        workerQueueLength: Number(workerQueueLength),
      };
    }
  }

  async #callAcknowledgeMessage({
    message,
    removeFromWorkerQueue,
  }: {
    message: OutputPayload;
    removeFromWorkerQueue?: boolean;
  }) {
    const messageId = message.runId;
    const messageKey = this.keys.messageKey(message.orgId, messageId);
    const messageQueue = message.queue;
    const queueCurrentConcurrencyKey = this.keys.queueCurrentConcurrencyKeyFromQueue(message.queue);
    const envCurrentConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
    const queueCurrentDequeuedKey = this.keys.queueCurrentDequeuedKeyFromQueue(message.queue);
    const envCurrentDequeuedKey = this.keys.envCurrentDequeuedKeyFromQueue(message.queue);
    const envQueueKey = this.keys.envQueueKeyFromQueue(message.queue);
    const masterQueueKey = this.keys.masterQueueKeyForEnvironment(
      message.environmentId,
      this.shardCount
    );
    const workerQueue = this.#getWorkerQueueFromMessage(message);
    const workerQueueKey = this.keys.workerQueueKey(workerQueue);
    const messageKeyValue = this.keys.messageKey(message.orgId, messageId);

    this.logger.debug("Calling acknowledgeMessage", {
      messageKey,
      messageQueue,
      queueCurrentConcurrencyKey,
      envCurrentConcurrencyKey,
      queueCurrentDequeuedKey,
      envCurrentDequeuedKey,
      envQueueKey,
      messageId,
      masterQueueKey,
      workerQueue,
      workerQueueKey,
      removeFromWorkerQueue,
      messageKeyValue,
      service: this.name,
    });

    return this.redis.acknowledgeMessage(
      masterQueueKey,
      messageKey,
      messageQueue,
      queueCurrentConcurrencyKey,
      envCurrentConcurrencyKey,
      queueCurrentDequeuedKey,
      envCurrentDequeuedKey,
      envQueueKey,
      workerQueueKey,
      messageId,
      messageQueue,
      messageKeyValue,
      removeFromWorkerQueue ? "1" : "0"
    );
  }

  async #callNackMessage({ message, retryAt }: { message: OutputPayload; retryAt?: number }) {
    const messageId = message.runId;
    const messageKey = this.keys.messageKey(message.orgId, message.runId);
    const messageQueue = message.queue;
    const queueCurrentConcurrencyKey = this.keys.queueCurrentConcurrencyKeyFromQueue(message.queue);
    const envCurrentConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
    const queueCurrentDequeuedKey = this.keys.queueCurrentDequeuedKeyFromQueue(message.queue);
    const envCurrentDequeuedKey = this.keys.envCurrentDequeuedKeyFromQueue(message.queue);
    const envQueueKey = this.keys.envQueueKeyFromQueue(message.queue);
    const masterQueueKey = this.keys.masterQueueKeyForEnvironment(
      message.environmentId,
      this.shardCount
    );

    const nextRetryDelay = calculateNextRetryDelay(this.retryOptions, message.attempt);
    const messageScore = retryAt ?? (nextRetryDelay ? Date.now() + nextRetryDelay : Date.now());

    this.logger.debug("Calling nackMessage", {
      messageKey,
      messageQueue,
      masterQueueKey,
      queueCurrentConcurrencyKey,
      envCurrentConcurrencyKey,
      queueCurrentDequeuedKey,
      envCurrentDequeuedKey,
      envQueueKey,
      messageId,
      messageScore,
      attempt: message.attempt,
      service: this.name,
    });

    await this.redis.nackMessage(
      //keys
      masterQueueKey,
      messageKey,
      messageQueue,
      queueCurrentConcurrencyKey,
      envCurrentConcurrencyKey,
      queueCurrentDequeuedKey,
      envCurrentDequeuedKey,
      envQueueKey,
      //args
      messageId,
      messageQueue,
      JSON.stringify(message),
      String(messageScore)
    );
  }

  async #callMoveToDeadLetterQueue({ message }: { message: OutputPayload }) {
    const messageId = message.runId;
    const messageKey = this.keys.messageKey(message.orgId, message.runId);
    const messageQueue = message.queue;
    const queueCurrentConcurrencyKey = this.keys.queueCurrentConcurrencyKeyFromQueue(message.queue);
    const envCurrentConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
    const queueCurrentDequeuedKey = this.keys.queueCurrentDequeuedKeyFromQueue(message.queue);
    const envCurrentDequeuedKey = this.keys.envCurrentDequeuedKeyFromQueue(message.queue);
    const envQueueKey = this.keys.envQueueKeyFromQueue(message.queue);
    const deadLetterQueueKey = this.keys.deadLetterQueueKeyFromQueue(message.queue);
    const masterQueueKey = this.keys.masterQueueKeyForEnvironment(
      message.environmentId,
      this.shardCount
    );

    await this.redis.moveToDeadLetterQueue(
      masterQueueKey,
      messageKey,
      messageQueue,
      queueCurrentConcurrencyKey,
      envCurrentConcurrencyKey,
      queueCurrentDequeuedKey,
      envCurrentDequeuedKey,
      envQueueKey,
      deadLetterQueueKey,
      messageId,
      messageQueue
    );
  }

  #callUpdateEnvironmentConcurrencyLimits({
    envConcurrencyLimitKey,
    envConcurrencyLimit,
    envConcurrencyLimitBurstFactorKey,
    envConcurrencyLimitBurstFactor,
  }: {
    envConcurrencyLimitKey: string;
    envConcurrencyLimit: number;
    envConcurrencyLimitBurstFactorKey: string;
    envConcurrencyLimitBurstFactor: string;
  }) {
    return this.redis.updateEnvironmentConcurrencyLimits(
      envConcurrencyLimitKey,
      envConcurrencyLimitBurstFactorKey,
      String(envConcurrencyLimit),
      envConcurrencyLimitBurstFactor
    );
  }

  #getWorkerQueueFromMessage(message: OutputPayload) {
    if (message.version === "2") {
      return message.workerQueue;
    }

    // In v2, if the environment is development, the worker queue is the environment id.
    if (message.environmentType === "DEVELOPMENT") {
      return message.environmentId;
    }

    // In v1, the master queue is something like us-nyc-3,
    // which in v2 is the worker queue.
    return message.masterQueues[0];
  }

  #createBlockingDequeueClient() {
    const blockingClient = this.redis.duplicate();

    return blockingClient;
  }

  // Call this every 10 minutes
  private async scanConcurrencySets() {
    if (this.abortController.signal.aborted) {
      return;
    }

    this.logger.debug("Scanning concurrency sets for completed runs");

    const stats = {
      streamCallbacks: 0,
      processedKeys: 0,
    };

    const { promise, resolve, reject } = promiseWithResolvers<typeof stats>();

    const { stream, redis } = this.currentConcurrencyScanStream(
      10,
      () => {
        this.logger.debug("Concurrency scan stream closed", { stats });

        resolve(stats);
      },
      (error) => {
        this.logger.error("Concurrency scan stream error", {
          stats,
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        });

        reject(error);
      }
    );

    stream.on("data", async (keys: string[]) => {
      if (!keys || keys.length === 0) {
        return;
      }

      stream.pause();

      if (this.abortController.signal.aborted) {
        stream.destroy();
        return;
      }

      stats.streamCallbacks++;

      const uniqueKeys = Array.from(new Set<string>(keys)).map((key) =>
        key.replace(redis.options.keyPrefix ?? "", "")
      );

      if (uniqueKeys.length === 0) {
        stream.resume();
        return;
      }

      this.logger.debug("Processing concurrency keys from stream", {
        keys: uniqueKeys,
      });

      stats.processedKeys += uniqueKeys.length;

      await Promise.allSettled(uniqueKeys.map((key) => this.processConcurrencySet(key))).finally(
        () => {
          stream.resume();
        }
      );
    });

    return promise;
  }

  private async processConcurrencySet(concurrencyKey: string) {
    const stream = this.redis.sscanStream(concurrencyKey, {
      count: 100,
    });

    const { promise, resolve, reject } = promiseWithResolvers<void>();

    stream.on("end", () => {
      resolve();
    });

    stream.on("error", (error) => {
      this.logger.error("Error in sscanStream for concurrency set", {
        concurrencyKey,
        error,
      });

      reject(error);
    });

    stream.on("data", async (runIds: string[]) => {
      stream.pause();

      if (this.abortController.signal.aborted) {
        stream.destroy();
        return;
      }

      if (!runIds || runIds.length === 0) {
        stream.resume();
        return;
      }

      const deduplicatedRunIds = Array.from(new Set(runIds));

      const [processError] = await tryCatch(
        this.processCurrentConcurrencyRunIds(concurrencyKey, deduplicatedRunIds)
      );

      if (processError) {
        this.logger.error("Error processing concurrency set", {
          concurrencyKey,
          runIds,
          error: processError,
        });
      }

      stream.resume();
    });

    return promise;
  }

  private async processCurrentConcurrencyRunIds(concurrencyKey: string, runIds: string[]) {
    this.logger.debug(`Processing concurrency set with ${runIds.length} runs`, {
      concurrencyKey,
      runIds: runIds.slice(0, 5), // Log first 5 for debugging
    });

    // Call the callback to determine which runs are completed
    const completedRuns = await this.options.concurrencySweeper?.callback(runIds);

    if (!completedRuns) {
      this.logger.debug("No completed runs found in concurrency set", { concurrencyKey });
      return;
    }

    if (completedRuns.length === 0) {
      this.logger.debug("No completed runs found in concurrency set", { concurrencyKey });
      return;
    }

    this.logger.debug(`Found ${completedRuns.length} completed runs to mark for ack`, {
      concurrencyKey,
      completedRunIds: completedRuns.map((r) => r.id).slice(0, 5),
    });

    // Mark the completed runs for acknowledgment
    await this.markRunsForAck(completedRuns);
  }

  private async markRunsForAck(completedRuns: Array<{ id: string; orgId: string }>) {
    const markedForAckKey = this.keys.markedForAckKey();

    // Prepare arguments: alternating orgId, messageId pairs
    const args: Array<number | string> = [];
    for (const run of completedRuns) {
      this.logger.info("Marking run for acknowledgment", {
        orgId: run.orgId,
        runId: run.id,
      });

      args.push(Date.now());
      args.push(`${run.orgId}:${run.id}`);
    }

    const count = await this.redis.zadd(markedForAckKey, ...args);

    this.logger.debug(`Marked ${count} runs for acknowledgment`, {
      markedForAckKey,
      count,
    });
  }

  // Call this every 5 minutes
  private async processMarkedRuns() {
    if (this.abortController.signal.aborted) {
      return;
    }

    try {
      const markedForAckKey = this.keys.markedForAckKey();
      const results = await this.redis.getMarkedRunsForAck(markedForAckKey, "100");

      if (results.length === 0) {
        return;
      }

      const markedRuns: MarkedRun[] = [];

      // Parse results: [orgId1, messageId1, score1, orgId2, messageId2, score2, ...]
      for (let i = 0; i < results.length; i += 3) {
        markedRuns.push({
          orgId: results[i],
          messageId: results[i + 1],
          score: Number(results[i + 2]),
        });
      }

      this.logger.debug(`Processing ${markedRuns.length} marked runs for acknowledgment`, {
        markedRuns: markedRuns, // Log first 3 for debugging
      });

      for (const run of markedRuns) {
        const [processError] = await tryCatch(this.processMarkedRun(run));

        if (processError) {
          this.logger.error("Error processing marked run", {
            error: processError,
            orgId: run.orgId,
            messageId: run.messageId,
          });
        }
      }

      const shouldProcessMoreRuns = (await this.redis.zcard(markedForAckKey)) > 0;

      if (shouldProcessMoreRuns) {
        await setTimeout(1000);
        await this.processMarkedRuns();
      }
    } catch (error) {
      this.logger.error("Error processing marked runs", { error });
    }
  }

  async processMarkedRun(run: MarkedRun) {
    this.logger.info("Acknowledging marked run", {
      orgId: run.orgId,
      messageId: run.messageId,
    });

    await this.acknowledgeMessage(run.orgId, run.messageId, {
      skipDequeueProcessing: true,
      removeFromWorkerQueue: false,
    });
  }

  async #dequeueMessageFromKey(messageKey: string) {
    return this.#trace("dequeueMessageFromKey", async (span) => {
      span.setAttributes({
        messageKey,
      });

      const rawMessage = await this.redis.dequeueMessageFromKey(
        messageKey,
        this.options.redis.keyPrefix ?? ""
      );

      if (!rawMessage) {
        span.setAttribute("result", "NO_MESSAGE");

        return;
      }

      const [error, message] = parseRawMessage(rawMessage);

      if (error) {
        this.logger.error(`[${this.name}] Failed to parse message`, {
          messageKey,
          error,
          service: this.name,
          message: message ?? rawMessage,
        });
      }

      if (message) {
        span.setAttribute("result", "SUCCESS");
        span.setAttribute("messageId", message.runId);
      } else {
        span.setAttribute("result", "NO_MESSAGE");
      }

      return message;
    });
  }

  #registerCommands() {
    this.redis.defineCommand("migrateLegacyMasterQueues", {
      numberOfKeys: 1,
      lua: `
local masterQueueKey = KEYS[1]

local keyPrefix = ARGV[1]

for i = 2, #ARGV do
  local queueName = ARGV[i]
  local queueKey = keyPrefix .. queueName
  
  -- Rebalance the parent queues
  local earliestMessage = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')

  if #earliestMessage == 0 then
    redis.call('ZREM', masterQueueKey, queueName)
  else
    redis.call('ZADD', masterQueueKey, earliestMessage[2], queueName)
  end
end
      `,
    });

    this.redis.defineCommand("enqueueMessage", {
      numberOfKeys: 8,
      lua: `
local masterQueueKey = KEYS[1]
local queueKey = KEYS[2]
local messageKey = KEYS[3]
local queueCurrentConcurrencyKey = KEYS[4]
local envCurrentConcurrencyKey = KEYS[5]
local queueCurrentDequeuedKey = KEYS[6]
local envCurrentDequeuedKey = KEYS[7]
local envQueueKey = KEYS[8]

local queueName = ARGV[1]
local messageId = ARGV[2]
local messageData = ARGV[3]
local messageScore = ARGV[4]

-- Write the message to the message key
redis.call('SET', messageKey, messageData)

-- Add the message to the queue
redis.call('ZADD', queueKey, messageScore, messageId)

-- Add the message to the env queue
redis.call('ZADD', envQueueKey, messageScore, messageId)

-- Rebalance the parent queues
local earliestMessage = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')

if #earliestMessage == 0 then
  redis.call('ZREM', masterQueueKey, queueName)
else
  redis.call('ZADD', masterQueueKey, earliestMessage[2], queueName)
end

-- Update the concurrency keys
redis.call('SREM', queueCurrentConcurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
redis.call('SREM', queueCurrentDequeuedKey, messageId)
redis.call('SREM', envCurrentDequeuedKey, messageId)
      `,
    });

    this.redis.defineCommand("dequeueMessagesFromQueue", {
      numberOfKeys: 9,
      lua: `
local queueKey = KEYS[1]
local queueConcurrencyLimitKey = KEYS[2]
local envConcurrencyLimitKey = KEYS[3]
local envConcurrencyLimitBurstFactorKey = KEYS[4]
local queueCurrentConcurrencyKey = KEYS[5]
local envCurrentConcurrencyKey = KEYS[6]
local messageKeyPrefix = KEYS[7]
local envQueueKey = KEYS[8]
local masterQueueKey = KEYS[9]

local queueName = ARGV[1]
local currentTime = tonumber(ARGV[2])
local defaultEnvConcurrencyLimit = ARGV[3]
local defaultEnvConcurrencyBurstFactor = ARGV[4]
local keyPrefix = ARGV[5]
local maxCount = tonumber(ARGV[6] or '1')

-- Check current env concurrency against the limit
local envCurrentConcurrency = tonumber(redis.call('SCARD', envCurrentConcurrencyKey) or '0')
local envConcurrencyLimit = tonumber(redis.call('GET', envConcurrencyLimitKey) or defaultEnvConcurrencyLimit)
local envConcurrencyLimitBurstFactor = tonumber(redis.call('GET', envConcurrencyLimitBurstFactorKey) or defaultEnvConcurrencyBurstFactor)
local envConcurrencyLimitWithBurstFactor = math.floor(envConcurrencyLimit * envConcurrencyLimitBurstFactor)

if envCurrentConcurrency >= envConcurrencyLimitWithBurstFactor then
    return nil
end

-- Check current queue concurrency against the limit
local queueCurrentConcurrency = tonumber(redis.call('SCARD', queueCurrentConcurrencyKey) or '0')
local queueConcurrencyLimit = math.min(tonumber(redis.call('GET', queueConcurrencyLimitKey) or '1000000'), envConcurrencyLimit)
local totalQueueConcurrencyLimit = queueConcurrencyLimit

-- Check condition only if concurrencyLimit exists
if queueCurrentConcurrency >= totalQueueConcurrencyLimit then
    return nil
end

-- Calculate how many messages we can actually dequeue based on concurrency limits
local envAvailableCapacity = envConcurrencyLimitWithBurstFactor - envCurrentConcurrency
local queueAvailableCapacity = totalQueueConcurrencyLimit - queueCurrentConcurrency
local actualMaxCount = math.min(maxCount, envAvailableCapacity, queueAvailableCapacity)

if actualMaxCount <= 0 then
    return nil
end

-- Attempt to dequeue messages up to actualMaxCount
local messages = redis.call('ZRANGEBYSCORE', queueKey, '-inf', currentTime, 'WITHSCORES', 'LIMIT', 0, actualMaxCount)

if #messages == 0 then
    return nil
end

local results = {}
local dequeuedCount = 0

-- Process messages in pairs (messageId, score)
for i = 1, #messages, 2 do
    local messageId = messages[i]
    local messageScore = tonumber(messages[i + 1])
    
    -- Get the message payload
    local messageKey = messageKeyPrefix .. messageId
    local messagePayload = redis.call('GET', messageKey)
    
    if messagePayload then
        -- Update concurrency
        redis.call('ZREM', queueKey, messageId)
        redis.call('ZREM', envQueueKey, messageId)
        redis.call('SADD', queueCurrentConcurrencyKey, messageId)
        redis.call('SADD', envCurrentConcurrencyKey, messageId)
        
        -- Add to results
        table.insert(results, messageId)
        table.insert(results, messageScore)
        table.insert(results, messagePayload)
        
        dequeuedCount = dequeuedCount + 1
    end
end

-- Rebalance the parent queues only once after all dequeues
local earliestMessage = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')

if #earliestMessage == 0 then
  redis.call('ZREM', masterQueueKey, queueName)
else
  redis.call('ZADD', masterQueueKey, earliestMessage[2], queueName)
end

-- Return results as a flat array: [messageId1, messageScore1, messagePayload1, messageId2, messageScore2, messagePayload2, ...]
return results
      `,
    });

    this.redis.defineCommand("dequeueMessageFromWorkerQueueNonBlocking", {
      numberOfKeys: 1,
      lua: `
local workerQueueKey = KEYS[1]

-- lpop the first message from the worker queue
local messageId = redis.call('LPOP', workerQueueKey)

-- if there is no messageId, return nil
if not messageId then
    return nil
end

-- get the length of the worker queue
local queueLength = tonumber(redis.call('LLEN', workerQueueKey) or '0')

return {messageId, queueLength} -- Return message details
      `,
    });

    this.redis.defineCommand("dequeueMessageFromKey", {
      numberOfKeys: 1,
      lua: `
-- Keys:
local messageKey = KEYS[1]

-- Args:
local keyPrefix = ARGV[1]

-- Get the raw messages string
local message = redis.call('GET', messageKey)

if not message then
  return nil
end

-- Parse the message
local messageData = cjson.decode(message)

-- Construct the "current dequeued" keys for the queue and the environment
local queueCurrentDequeuedKey = keyPrefix .. messageData.queue .. ':currentDequeued'
local envCurrentDequeuedKey = keyPrefix ..  string.match(messageData.queue, "(.+):queue:") .. ":currentDequeued"

-- Update the concurrency keys
redis.call('SADD', queueCurrentDequeuedKey, messageData.runId)
redis.call('SADD', envCurrentDequeuedKey, messageData.runId)

-- Return the message data
return message
      `,
    });

    this.redis.defineCommand("acknowledgeMessage", {
      numberOfKeys: 9,
      lua: `
-- Keys:
local masterQueueKey = KEYS[1]
local messageKey = KEYS[2]
local messageQueueKey = KEYS[3]
local queueCurrentConcurrencyKey = KEYS[4]
local envCurrentConcurrencyKey = KEYS[5]
local queueCurrentDequeuedKey = KEYS[6]
local envCurrentDequeuedKey = KEYS[7]
local envQueueKey = KEYS[8]
local workerQueueKey = KEYS[9]

-- Args:
local messageId = ARGV[1]
local messageQueueName = ARGV[2]
local messageKeyValue = ARGV[3]
local removeFromWorkerQueue = ARGV[4]

-- Remove the message from the message key
redis.call('DEL', messageKey)

-- Remove the message from the queue
redis.call('ZREM', messageQueueKey, messageId)
redis.call('ZREM', envQueueKey, messageId)

-- Rebalance the parent queues
local earliestMessage = redis.call('ZRANGE', messageQueueKey, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
  redis.call('ZREM', masterQueueKey, messageQueueName)
else
  redis.call('ZADD', masterQueueKey, earliestMessage[2], messageQueueName)
end

-- Update the concurrency keys
redis.call('SREM', queueCurrentConcurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
redis.call('SREM', queueCurrentDequeuedKey, messageId)
redis.call('SREM', envCurrentDequeuedKey, messageId)

-- Remove the message from the worker queue
if removeFromWorkerQueue == '1' then
  redis.call('LREM', workerQueueKey, 0, messageKeyValue)
end
`,
    });

    this.redis.defineCommand("nackMessage", {
      numberOfKeys: 8,
      lua: `
-- Keys:
local masterQueueKey = KEYS[1]
local messageKey = KEYS[2]
local messageQueueKey = KEYS[3]
local queueCurrentConcurrencyKey = KEYS[4]
local envCurrentConcurrencyKey = KEYS[5]
local queueCurrentDequeuedKey = KEYS[6]
local envCurrentDequeuedKey = KEYS[7]
local envQueueKey = KEYS[8]

-- Args:
local messageId = ARGV[1]
local messageQueueName = ARGV[2]
local messageData = ARGV[3]
local messageScore = tonumber(ARGV[4])

-- Update the message data
redis.call('SET', messageKey, messageData)

-- Update the concurrency keys
redis.call('SREM', queueCurrentConcurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
redis.call('SREM', queueCurrentDequeuedKey, messageId)
redis.call('SREM', envCurrentDequeuedKey, messageId)

-- Enqueue the message into the queue
redis.call('ZADD', messageQueueKey, messageScore, messageId)
redis.call('ZADD', envQueueKey, messageScore, messageId)

-- Rebalance the parent queues
local earliestMessage = redis.call('ZRANGE', messageQueueKey, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
  redis.call('ZREM', masterQueueKey, messageQueueName)
else
  redis.call('ZADD', masterQueueKey, earliestMessage[2], messageQueueName)
end
`,
    });

    this.redis.defineCommand("moveToDeadLetterQueue", {
      numberOfKeys: 9,
      lua: `
-- Keys:
local masterQueueKey = KEYS[1]
local messageKey = KEYS[2]
local messageQueue = KEYS[3]
local queueCurrentConcurrencyKey = KEYS[4]
local envCurrentConcurrencyKey = KEYS[5]
local queueCurrentDequeuedKey = KEYS[6]
local envCurrentDequeuedKey = KEYS[7]
local envQueueKey = KEYS[8]
local deadLetterQueueKey = KEYS[9]

-- Args:
local messageId = ARGV[1]
local messageQueueName = ARGV[2]

-- Remove the message from the queue
redis.call('ZREM', messageQueue, messageId)
redis.call('ZREM', envQueueKey, messageId)

-- Rebalance the parent queues
local earliestMessage = redis.call('ZRANGE', messageQueue, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
  redis.call('ZREM', masterQueueKey, messageQueueName)
else
  redis.call('ZADD', masterQueueKey, earliestMessage[2], messageQueueName)
end

-- Add the message to the dead letter queue
redis.call('ZADD', deadLetterQueueKey, tonumber(redis.call('TIME')[1]), messageId)

-- Update the concurrency keys
redis.call('SREM', queueCurrentConcurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
redis.call('SREM', queueCurrentDequeuedKey, messageId)
redis.call('SREM', envCurrentDequeuedKey, messageId)
`,
    });

    this.redis.defineCommand("releaseConcurrency", {
      numberOfKeys: 4,
      lua: `
-- Keys:
local queueCurrentConcurrencyKey = KEYS[1]
local envCurrentConcurrencyKey = KEYS[2]
local queueCurrentDequeuedKey = KEYS[3]
local envCurrentDequeuedKey = KEYS[4]

-- Args:
local messageId = ARGV[1]

-- Update the concurrency keys
redis.call('SREM', queueCurrentConcurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
redis.call('SREM', queueCurrentDequeuedKey, messageId)
redis.call('SREM', envCurrentDequeuedKey, messageId)
`,
    });

    this.redis.defineCommand("updateEnvironmentConcurrencyLimits", {
      numberOfKeys: 2,
      lua: `
-- Keys: envConcurrencyLimitKey, envConcurrencyLimitBurstFactorKey
local envConcurrencyLimitKey = KEYS[1]
local envConcurrencyLimitBurstFactorKey = KEYS[2]

-- Args: envConcurrencyLimit
local envConcurrencyLimit = ARGV[1]
local envConcurrencyLimitBurstFactor = ARGV[2]

redis.call('SET', envConcurrencyLimitKey, envConcurrencyLimit)
redis.call('SET', envConcurrencyLimitBurstFactorKey, envConcurrencyLimitBurstFactor)
      `,
    });

    this.redis.defineCommand("markCompletedRunsForAck", {
      numberOfKeys: 1,
      lua: `
-- Keys:
local markedForAckKey = KEYS[1]

-- Args: alternating orgId, messageId pairs
local currentTime = tonumber(redis.call('TIME')[1]) * 1000

for i = 1, #ARGV, 2 do
    local orgId = ARGV[i]
    local messageId = ARGV[i + 1]
    local markedValue = orgId .. ':' .. messageId
    
    redis.call('ZADD', markedForAckKey, currentTime, markedValue)
end

return #ARGV / 2
      `,
    });

    this.redis.defineCommand("getMarkedRunsForAck", {
      numberOfKeys: 1,
      lua: `
-- Keys:
local markedForAckKey = KEYS[1]

-- Args:
local maxCount = tonumber(ARGV[1] or '10')

-- Get the oldest marked runs
local markedRuns = redis.call('ZRANGE', markedForAckKey, 0, maxCount - 1, 'WITHSCORES')

local results = {}
for i = 1, #markedRuns, 2 do
    local markedValue = markedRuns[i]
    local score = markedRuns[i + 1]
    
    -- Parse orgId:messageId
    local colonIndex = string.find(markedValue, ':')
    if colonIndex then
        local orgId = string.sub(markedValue, 1, colonIndex - 1)
        local messageId = string.sub(markedValue, colonIndex + 1)
        
        table.insert(results, orgId)
        table.insert(results, messageId)
        table.insert(results, score)
    end
end

-- Remove the processed items
if #results > 0 then
    local itemsToRemove = {}
    for i = 1, #markedRuns, 2 do
        table.insert(itemsToRemove, markedRuns[i])
    end
    redis.call('ZREM', markedForAckKey, unpack(itemsToRemove))
end

return results
      `,
    });
  }
}

function safeJsonParse(rawMessage: string): unknown {
  try {
    return JSON.parse(rawMessage);
  } catch (e) {
    return undefined;
  }
}

declare module "@internal/redis" {
  interface RedisCommander<Context> {
    enqueueMessage(
      //keys
      masterQueueKey: string,
      queue: string,
      messageKey: string,
      queueCurrentConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      queueCurrentDequeuedKey: string,
      envCurrentDequeuedKey: string,
      envQueueKey: string,
      //args
      queueName: string,
      messageId: string,
      messageData: string,
      messageScore: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    dequeueMessagesFromQueue(
      //keys
      childQueue: string,
      queueConcurrencyLimitKey: string,
      envConcurrencyLimitKey: string,
      envConcurrencyLimitBurstFactorKey: string,
      queueCurrentConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      messageKeyPrefix: string,
      envQueueKey: string,
      masterQueueKey: string,
      //args
      childQueueName: string,
      currentTime: string,
      defaultEnvConcurrencyLimit: string,
      defaultEnvConcurrencyBurstFactor: string,
      keyPrefix: string,
      maxCount: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;

    dequeueMessageFromWorkerQueueNonBlocking(
      workerQueueKey: string,
      callback?: Callback<[string, string] | undefined>
    ): Result<[string, string] | undefined, Context>;

    dequeueMessageFromKey(
      // keys
      messageKey: string,
      // args
      keyPrefix: string,
      callback?: Callback<string | null>
    ): Result<string | null, Context>;

    acknowledgeMessage(
      // keys
      masterQueueKey: string,
      messageKey: string,
      messageQueue: string,
      queueCurrentConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      queueCurrentDequeuedKey: string,
      envCurrentDequeuedKey: string,
      envQueueKey: string,
      workerQueueKey: string,
      // args
      messageId: string,
      messageQueueName: string,
      messageKeyValue: string,
      removeFromWorkerQueue: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    nackMessage(
      // keys
      masterQueueKey: string,
      messageKey: string,
      messageQueue: string,
      queueCurrentConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      queueCurrentDequeuedKey: string,
      envCurrentDequeuedKey: string,
      envQueueKey: string,
      // args
      messageId: string,
      messageQueueName: string,
      messageData: string,
      messageScore: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    moveToDeadLetterQueue(
      // keys
      masterQueueKey: string,
      messageKey: string,
      messageQueue: string,
      queueCurrentConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      queueCurrentDequeuedKey: string,
      envCurrentDequeuedKey: string,
      envQueueKey: string,
      deadLetterQueueKey: string,
      // args
      messageId: string,
      messageQueueName: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    releaseConcurrency(
      // keys
      queueCurrentConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      queueCurrentDequeuedKey: string,
      envCurrentDequeuedKey: string,
      // args
      messageId: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    updateEnvironmentConcurrencyLimits(
      // keys
      envConcurrencyLimitKey: string,
      envConcurrencyLimitBurstFactorKey: string,
      envConcurrencyLimit: string,
      envConcurrencyLimitBurstFactor: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    migrateLegacyMasterQueues(
      masterQueueKey: string,
      keyPrefix: string,
      ...queueNames: string[]
    ): Result<void, Context>;

    getMarkedRunsForAck(
      markedForAckKey: string,
      maxCount: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
  }
}

type ParseRawMessageResult = [Error | null, OutputPayload | null];

function parseRawMessage(rawMessage: string): ParseRawMessageResult {
  const deserializedMessage = safeJsonParse(rawMessage);

  const message = OutputPayload.safeParse(deserializedMessage);

  // If the message is not valid, return the error to be logged
  // but also still return the deserialized message as the OutputPayload
  // to prevent forward compatibility issues
  if (!message.success) {
    return [message.error, deserializedMessage as OutputPayload];
  }

  return [null, message.data];
}
