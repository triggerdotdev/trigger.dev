import { context, propagation, Span, SpanKind, SpanOptions, Tracer } from "@opentelemetry/api";
import {
  SEMATTRS_MESSAGE_ID,
  SEMATTRS_MESSAGING_OPERATION,
  SEMATTRS_MESSAGING_SYSTEM,
} from "@opentelemetry/semantic-conventions";
import { Logger } from "@trigger.dev/core/logger";
import { flattenAttributes } from "@trigger.dev/core/v3";
import { Redis, type Callback, type RedisOptions, type Result } from "ioredis";
import { AsyncWorker } from "../shared/asyncWorker.js";
import { attributesFromAuthenticatedEnv, AuthenticatedEnvironment } from "../shared/index.js";
import {
  MessagePayload,
  QueueCapacities,
  QueueRange,
  RunQueueKeyProducer,
  RunQueuePriorityStrategy,
} from "./types.js";

const SemanticAttributes = {
  QUEUE: "runqueue.queue",
  PARENT_QUEUE: "runqueue.parentQueue",
  RUN_ID: "runqueue.runId",
  CONCURRENCY_KEY: "runqueue.concurrencyKey",
  ORG_ID: "runqueue.orgId",
};

export type RunQueueOptions = {
  name: string;
  tracer: Tracer;
  redis: RedisOptions;
  defaultEnvConcurrency: number;
  windowSize?: number;
  workers: number;
  keysProducer: RunQueueKeyProducer;
  queuePriorityStrategy: RunQueuePriorityStrategy;
  envQueuePriorityStrategy: RunQueuePriorityStrategy;
  enableRebalancing?: boolean;
  verbose?: boolean;
  logger: Logger;
};

/**
 * RunQueue – the queue that's used to process runs
 */
export class RunQueue {
  private logger: Logger;
  private redis: Redis;
  public keys: RunQueueKeyProducer;
  private queuePriorityStrategy: RunQueuePriorityStrategy;
  #rebalanceWorkers: Array<AsyncWorker> = [];

  constructor(private readonly options: RunQueueOptions) {
    this.redis = new Redis(options.redis);
    this.logger = options.logger;

    this.keys = options.keysProducer;
    this.queuePriorityStrategy = options.queuePriorityStrategy;

    this.#startRebalanceWorkers();
    this.#registerCommands();
  }

  get name() {
    return this.options.name;
  }

  get tracer() {
    return this.options.tracer;
  }

  public async updateQueueConcurrencyLimits(
    env: AuthenticatedEnvironment,
    queue: string,
    concurrency: number
  ) {
    return this.redis.set(this.keys.queueConcurrencyLimitKey(env, queue), concurrency);
  }

  public async removeQueueConcurrencyLimits(env: AuthenticatedEnvironment, queue: string) {
    return this.redis.del(this.keys.queueConcurrencyLimitKey(env, queue));
  }

  public async getQueueConcurrencyLimit(env: AuthenticatedEnvironment, queue: string) {
    const result = await this.redis.get(this.keys.queueConcurrencyLimitKey(env, queue));

    return result ? Number(result) : undefined;
  }

  public async updateEnvConcurrencyLimits(env: AuthenticatedEnvironment) {
    await this.#callUpdateGlobalConcurrencyLimits({
      envConcurrencyLimitKey: this.keys.envConcurrencyLimitKey(env),
      envConcurrencyLimit: env.maximumConcurrencyLimit,
    });
  }

  public async getEnvConcurrencyLimit(env: AuthenticatedEnvironment) {
    const result = await this.redis.get(this.keys.envConcurrencyLimitKey(env));

    return result ? Number(result) : this.options.defaultEnvConcurrency;
  }

  public async lengthOfQueue(
    env: AuthenticatedEnvironment,
    queue: string,
    concurrencyKey?: string
  ) {
    return this.redis.zcard(this.keys.queueKey(env, queue, concurrencyKey));
  }

  public async oldestMessageInQueue(
    env: AuthenticatedEnvironment,
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

    return Number(result[1]);
  }

  public async currentConcurrencyOfQueue(
    env: AuthenticatedEnvironment,
    queue: string,
    concurrencyKey?: string
  ) {
    return this.redis.scard(this.keys.currentConcurrencyKey(env, queue, concurrencyKey));
  }

  public async currentConcurrencyOfEnvironment(env: AuthenticatedEnvironment) {
    return this.redis.scard(this.keys.envCurrentConcurrencyKey(env));
  }

  public async enqueueMessage({
    env,
    message,
  }: {
    env: AuthenticatedEnvironment;
    message: MessagePayload;
  }) {
    return await this.#trace(
      "enqueueMessage",
      async (span) => {
        const { runId, concurrencyKey } = message;

        const queue = this.keys.queueKey(env, message.queue, concurrencyKey);

        const parentQueue = this.keys.envSharedQueueKey(env);

        propagation.inject(context.active(), message);

        span.setAttributes({
          [SemanticAttributes.QUEUE]: queue,
          [SemanticAttributes.RUN_ID]: runId,
          [SemanticAttributes.CONCURRENCY_KEY]: concurrencyKey,
          [SemanticAttributes.PARENT_QUEUE]: parentQueue,
        });

        const messagePayload: MessagePayload = {
          ...message,
          queue,
        };

        await this.#callEnqueueMessage(messagePayload);
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

  public async dequeueMessageInEnv(env: AuthenticatedEnvironment) {
    return this.#trace(
      "dequeueMessageInEnv",
      async (span) => {
        const parentQueue = this.keys.envSharedQueueKey(env);

        // Read the parent queue for matching queues
        const messageQueue = await this.#getRandomQueueFromParentQueue(
          parentQueue,
          this.options.envQueuePriorityStrategy,
          (queue) => this.#calculateMessageQueueCapacities(queue, { checkForDisabled: false }),
          env.id
        );

        if (!messageQueue) {
          return;
        }

        const message = await this.#callDequeueMessage({
          messageQueue,
          parentQueue,
          concurrencyLimitKey: this.keys.concurrencyLimitKeyFromQueue(messageQueue),
          currentConcurrencyKey: this.keys.currentConcurrencyKeyFromQueue(messageQueue),
          envConcurrencyLimitKey: this.keys.envConcurrencyLimitKeyFromQueue(messageQueue),
          envCurrentConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(messageQueue),
        });

        if (!message) {
          return;
        }

        span.setAttributes({
          [SEMATTRS_MESSAGE_ID]: message.messageId,
          [SemanticAttributes.QUEUE]: message.message.queue,
          [SemanticAttributes.RUN_ID]: message.message.runId,
          [SemanticAttributes.CONCURRENCY_KEY]: message.message.concurrencyKey,
          [SemanticAttributes.PARENT_QUEUE]: message.message.parentQueue,
        });

        return message;
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "receive",
          [SEMATTRS_MESSAGING_SYSTEM]: "runqueue",
          ...attributesFromAuthenticatedEnv(env),
        },
      }
    );
  }

  public async getSharedQueueDetails() {
    const parentQueue = this.keys.sharedQueueKey();

    const { range } = await this.queuePriorityStrategy.nextCandidateSelection(
      parentQueue,
      "getSharedQueueDetails"
    );
    const queues = await this.#getChildQueuesWithScores(parentQueue, range);

    const queuesWithScores = await this.#calculateQueueScores(queues, (queue) =>
      this.#calculateMessageQueueCapacities(queue)
    );

    // We need to priority shuffle here to ensure all workers aren't just working on the highest priority queue
    const choice = this.queuePriorityStrategy.chooseQueue(
      queuesWithScores,
      parentQueue,
      "getSharedQueueDetails",
      range
    );

    return {
      selectionId: "getSharedQueueDetails",
      queues,
      queuesWithScores,
      nextRange: range,
      queueCount: queues.length,
      queueChoice: choice,
    };
  }

  /**
   * Dequeue a message from the shared queue (this should be used in production environments)
   */
  public async dequeueMessageInSharedQueue(consumerId: string) {
    return this.#trace(
      "dequeueMessageInSharedQueue",
      async (span) => {
        const parentQueue = this.keys.sharedQueueKey();

        // Read the parent queue for matching queues
        const messageQueue = await this.#getRandomQueueFromParentQueue(
          parentQueue,
          this.options.queuePriorityStrategy,
          (queue) => this.#calculateMessageQueueCapacities(queue, { checkForDisabled: true }),
          consumerId
        );

        if (!messageQueue) {
          return;
        }

        // If the queue includes a concurrency key, we need to remove the ck:concurrencyKey from the queue name
        const message = await this.#callDequeueMessage({
          messageQueue,
          parentQueue,
          concurrencyLimitKey: this.keys.concurrencyLimitKeyFromQueue(messageQueue),
          currentConcurrencyKey: this.keys.currentConcurrencyKeyFromQueue(messageQueue),
          envConcurrencyLimitKey: this.keys.envConcurrencyLimitKeyFromQueue(messageQueue),
          envCurrentConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(messageQueue),
        });

        if (!message) {
          return;
        }

        span.setAttributes({
          [SEMATTRS_MESSAGE_ID]: message.messageId,
          [SemanticAttributes.QUEUE]: message.message.queue,
          [SemanticAttributes.RUN_ID]: message.message.runId,
          [SemanticAttributes.CONCURRENCY_KEY]: message.message.concurrencyKey,
          [SemanticAttributes.PARENT_QUEUE]: message.message.parentQueue,
        });

        return message;
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

  /**
   * Acknowledge a message, which will:
   * - remove all data from the queue
   * - release all concurrency
   * This is done when the run is in a final state.
   * @param orgId
   * @param messageId
   */
  public async acknowledgeMessage(orgId: string, messageId: string) {
    return this.#trace(
      "acknowledgeMessage",
      async (span) => {
        // span.setAttributes({
        //   [SemanticAttributes.RUN_ID]: messageId,
        //   [SemanticAttributes.ORG_ID]: orgId,
        // });
        // const message = await this.#callAcknowledgeMessage({
        //   messageKey: this.keys.messageKey(orgId, messageId),
        //   messageId,
        // });
        // span.setAttributes({
        //   [SemanticAttributes.RUN_ID]: messageId,
        //   [SemanticAttributes.QUEUE]: message.queue,
        //   [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
        //   [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
        // });
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
   * Negative acknowledge a message, which will requeue the message
   */
  public async nackMessage(
    messageId: string,
    retryAt: number = Date.now(),
    updates?: Record<string, unknown>
  ) {
    return this.#trace(
      "nackMessage",
      async (span) => {
        // const message = await this.readMessage(messageId);
        // if (!message) {
        //   logger.log(`[${this.name}].nackMessage() message not found`, {
        //     messageId,
        //     retryAt,
        //     updates,
        //     service: this.name,
        //   });
        //   return;
        // }
        // span.setAttributes({
        //   [SemanticAttributes.QUEUE]: message.queue,
        //   [SemanticAttributes.MESSAGE_ID]: message.messageId,
        //   [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
        //   [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
        // });
        // if (updates) {
        //   await this.replaceMessage(messageId, updates, retryAt, true);
        // }
        // await this.options.visibilityTimeoutStrategy.cancelHeartbeat(messageId);
        // await this.#callNackMessage({
        //   messageKey: this.keys.messageKey(messageId),
        //   messageQueue: message.queue,
        //   parentQueue: message.parentQueue,
        //   concurrencyKey: this.keys.currentConcurrencyKeyFromQueue(message.queue),
        //   envConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(message.queue),
        //   orgConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(message.queue),
        //   visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
        //   messageId,
        //   messageScore: retryAt,
        // });
        // await this.options.subscriber?.messageNacked(message);
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

  public async releaseConcurrency(messageId: string, releaseForRun: boolean = false) {
    return this.#trace(
      "releaseConcurrency",
      async (span) => {
        // span.setAttributes({
        //   [SemanticAttributes.MESSAGE_ID]: messageId,
        // });
        // const message = await this.readMessage(messageId);
        // if (!message) {
        //   logger.log(`[${this.name}].releaseConcurrency() message not found`, {
        //     messageId,
        //     releaseForRun,
        //     service: this.name,
        //   });
        //   return;
        // }
        // span.setAttributes({
        //   [SemanticAttributes.QUEUE]: message.queue,
        //   [SemanticAttributes.MESSAGE_ID]: message.messageId,
        //   [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
        //   [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
        // });
        // const concurrencyKey = this.keys.currentConcurrencyKeyFromQueue(message.queue);
        // const envConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
        // const orgConcurrencyKey = this.keys.orgCurrentConcurrencyKeyFromQueue(message.queue);
        // logger.debug("Calling releaseConcurrency", {
        //   messageId,
        //   queue: message.queue,
        //   concurrencyKey,
        //   envConcurrencyKey,
        //   orgConcurrencyKey,
        //   service: this.name,
        //   releaseForRun,
        // });
        // return this.redis.releaseConcurrency(
        //   //don't release the for the run, it breaks concurrencyLimits
        //   releaseForRun ? concurrencyKey : "",
        //   envConcurrencyKey,
        //   orgConcurrencyKey,
        //   message.messageId
        // );
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "releaseConcurrency",
          [SEMATTRS_MESSAGE_ID]: messageId,
          [SEMATTRS_MESSAGING_SYSTEM]: "runqueue",
        },
      }
    );
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

  async readMessage(orgId: string, messageId: string) {
    return this.#trace(
      "readMessage",
      async (span) => {
        const rawMessage = await this.redis.get(this.keys.messageKey(orgId, messageId));

        if (!rawMessage) {
          return;
        }

        const message = MessagePayload.safeParse(JSON.parse(rawMessage));

        if (!message.success) {
          this.logger.error(`[${this.name}] Failed to parse message`, {
            messageId,
            error: message.error,
            service: this.name,
          });

          return;
        }

        return message.data;
      },
      {
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "receive",
          [SEMATTRS_MESSAGE_ID]: messageId,
          [SEMATTRS_MESSAGING_SYSTEM]: "runqueue",
          [SemanticAttributes.RUN_ID]: messageId,
        },
      }
    );
  }

  async quit() {
    await Promise.all(this.#rebalanceWorkers.map((worker) => worker.stop()));
    await this.redis.quit();
  }

  async #getRandomQueueFromParentQueue(
    parentQueue: string,
    queuePriorityStrategy: RunQueuePriorityStrategy,
    calculateCapacities: (queue: string) => Promise<QueueCapacities>,
    consumerId: string
  ) {
    return this.#trace(
      "getRandomQueueFromParentQueue",
      async (span) => {
        span.setAttribute("consumerId", consumerId);

        const { range } = await queuePriorityStrategy.nextCandidateSelection(
          parentQueue,
          consumerId
        );

        const queues = await this.#getChildQueuesWithScores(parentQueue, range, span);
        span.setAttribute("queueCount", queues.length);

        const queuesWithScores = await this.#calculateQueueScores(queues, calculateCapacities);
        span.setAttribute("queuesWithScoresCount", queuesWithScores.length);

        // We need to priority shuffle here to ensure all workers aren't just working on the highest priority queue
        const { choice, nextRange } = this.queuePriorityStrategy.chooseQueue(
          queuesWithScores,
          parentQueue,
          consumerId,
          range
        );

        span.setAttributes({
          ...flattenAttributes(queues, "runqueue.queues"),
        });
        span.setAttributes({
          ...flattenAttributes(queuesWithScores, "runqueue.queuesWithScores"),
        });
        span.setAttribute("range.offset", range.offset);
        span.setAttribute("range.count", range.count);
        span.setAttribute("nextRange.offset", nextRange.offset);
        span.setAttribute("nextRange.count", nextRange.count);

        if (this.options.verbose || nextRange.offset > 0) {
          if (typeof choice === "string") {
            this.logger.debug(`[${this.name}] getRandomQueueFromParentQueue`, {
              queues,
              queuesWithScores,
              range,
              nextRange,
              queueCount: queues.length,
              queuesWithScoresCount: queuesWithScores.length,
              queueChoice: choice,
              consumerId,
            });
          } else {
            this.logger.debug(`[${this.name}] getRandomQueueFromParentQueue`, {
              queues,
              queuesWithScores,
              range,
              nextRange,
              queueCount: queues.length,
              queuesWithScoresCount: queuesWithScores.length,
              noQueueChoice: true,
              consumerId,
            });
          }
        }

        if (typeof choice !== "string") {
          span.setAttribute("noQueueChoice", true);

          return;
        } else {
          span.setAttribute("queueChoice", choice);

          return choice;
        }
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "receive",
          [SEMATTRS_MESSAGING_SYSTEM]: "runqueue",
          [SemanticAttributes.PARENT_QUEUE]: parentQueue,
        },
      }
    );
  }

  // Calculate the weights of the queues based on the age and the capacity
  async #calculateQueueScores(
    queues: Array<{ value: string; score: number }>,
    calculateCapacities: (queue: string) => Promise<QueueCapacities>
  ) {
    const now = Date.now();

    const queueScores = await Promise.all(
      queues.map(async (queue) => {
        return {
          queue: queue.value,
          capacities: await calculateCapacities(queue.value),
          age: now - queue.score,
          size: await this.redis.zcard(queue.value),
        };
      })
    );

    return queueScores;
  }

  async #calculateMessageQueueCapacities(queue: string, options?: { checkForDisabled?: boolean }) {
    return await this.#callCalculateMessageCapacities({
      currentConcurrencyKey: this.keys.currentConcurrencyKeyFromQueue(queue),
      currentEnvConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(queue),
      concurrencyLimitKey: this.keys.concurrencyLimitKeyFromQueue(queue),
      envConcurrencyLimitKey: this.keys.envConcurrencyLimitKeyFromQueue(queue),
      disabledConcurrencyLimitKey: options?.checkForDisabled
        ? this.keys.disabledConcurrencyLimitKeyFromQueue(queue)
        : undefined,
    });
  }

  async #getChildQueuesWithScores(
    key: string,
    range: QueueRange,
    span?: Span
  ): Promise<Array<{ value: string; score: number }>> {
    const valuesWithScores = await this.redis.zrangebyscore(
      key,
      "-inf",
      Date.now(),
      "WITHSCORES",
      "LIMIT",
      range.offset,
      range.count
    );

    span?.setAttribute("zrangebyscore.valuesWithScores.rawLength", valuesWithScores.length);
    span?.setAttributes({
      ...flattenAttributes(valuesWithScores, "zrangebyscore.valuesWithScores.rawValues"),
    });

    const result: Array<{ value: string; score: number }> = [];

    for (let i = 0; i < valuesWithScores.length; i += 2) {
      result.push({
        value: valuesWithScores[i],
        score: Number(valuesWithScores[i + 1]),
      });
    }

    return result;
  }

  #startRebalanceWorkers() {
    if (!this.options.enableRebalancing) {
      return;
    }

    // Start a new worker to rebalance parent queues periodically
    for (let i = 0; i < this.options.workers; i++) {
      const worker = new AsyncWorker(this.#rebalanceParentQueues.bind(this), 60_000);

      this.#rebalanceWorkers.push(worker);

      worker.start();
    }
  }

  queueConcurrencyScanStream(
    count: number = 100,
    onEndCallback?: () => void,
    onErrorCallback?: (error: Error) => void
  ) {
    const pattern = this.keys.queueCurrentConcurrencyScanPattern();

    this.logger.debug("Starting queue concurrency scan stream", {
      pattern,
      component: "runqueue",
      operation: "queueConcurrencyScanStream",
      service: this.name,
      count,
    });

    const redis = this.redis.duplicate();

    const stream = redis.scanStream({
      match: pattern,
      type: "set",
      count,
    });

    stream.on("end", () => {
      onEndCallback?.();
      redis.quit();
    });

    stream.on("error", (error) => {
      onErrorCallback?.(error);
      redis.quit();
    });

    return { stream, redis };
  }

  async #rebalanceParentQueues() {
    return await new Promise<void>((resolve, reject) => {
      // Scan for sorted sets with the parent queue pattern
      const pattern = this.keys.sharedQueueScanPattern();
      const redis = this.redis.duplicate();
      const stream = redis.scanStream({
        match: pattern,
        type: "zset",
        count: 100,
      });

      this.logger.debug("Streaming parent queues based on pattern", {
        pattern,
        component: "runqueue",
        operation: "rebalanceParentQueues",
        service: this.name,
      });

      stream.on("data", async (keys) => {
        const uniqueKeys = Array.from(new Set<string>(keys));

        if (uniqueKeys.length === 0) {
          return;
        }

        stream.pause();

        this.logger.debug("Rebalancing parent queues", {
          component: "runqueue",
          operation: "rebalanceParentQueues",
          parentQueues: uniqueKeys,
          service: this.name,
        });

        Promise.all(
          uniqueKeys.map(async (key) => this.#rebalanceParentQueue(this.keys.stripKeyPrefix(key)))
        ).finally(() => {
          stream.resume();
        });
      });

      stream.on("end", () => {
        redis.quit().finally(() => {
          resolve();
        });
      });

      stream.on("error", (e) => {
        redis.quit().finally(() => {
          reject(e);
        });
      });
    });
  }

  // Parent queue is a sorted set, the values of which are queue keys and the scores are is the oldest message in the queue
  // We need to scan the parent queue and rebalance the queues based on the oldest message in the queue
  async #rebalanceParentQueue(parentQueue: string) {
    return await new Promise<void>((resolve, reject) => {
      const redis = this.redis.duplicate();

      const stream = redis.zscanStream(parentQueue, {
        match: "*",
        count: 100,
      });

      stream.on("data", async (childQueues) => {
        stream.pause();

        // childQueues is a flat array but of the form [queue1, score1, queue2, score2, ...], we want to group them into pairs
        const childQueuesWithScores: Record<string, string> = {};

        for (let i = 0; i < childQueues.length; i += 2) {
          childQueuesWithScores[childQueues[i]] = childQueues[i + 1];
        }

        this.logger.debug("Rebalancing child queues", {
          parentQueue,
          childQueuesWithScores,
          component: "runqueue",
          operation: "rebalanceParentQueues",
          service: this.name,
        });

        await Promise.all(
          Object.entries(childQueuesWithScores).map(async ([childQueue, currentScore]) =>
            this.#callRebalanceParentQueueChild({ parentQueue, childQueue, currentScore })
          )
        ).finally(() => {
          stream.resume();
        });
      });

      stream.on("end", () => {
        redis.quit().finally(() => {
          resolve();
        });
      });

      stream.on("error", (e) => {
        redis.quit().finally(() => {
          reject(e);
        });
      });
    });
  }

  async #callEnqueueMessage(message: MessagePayload) {
    const concurrencyKey = this.keys.currentConcurrencyKeyFromQueue(message.queue);
    const envConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
    const taskConcurrencyTrackerKey = this.keys.currentTaskIdentifierKey({
      orgId: message.orgId,
      projectId: message.projectId,
      environmentId: message.environmentId,
      taskIdentifier: message.taskIdentifier,
    });
    const envConcurrencyTrackerKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);

    this.logger.debug("Calling enqueueMessage", {
      messagePayload: message,
      concurrencyKey,
      envConcurrencyKey,
      service: this.name,
    });

    return this.redis.enqueueMessage(
      message.queue,
      message.parentQueue,
      this.keys.messageKey(message.orgId, message.runId),
      concurrencyKey,
      envConcurrencyKey,
      taskConcurrencyTrackerKey,
      envConcurrencyTrackerKey,
      message.queue,
      message.runId,
      JSON.stringify(message),
      String(message.timestamp)
    );
  }

  async #callDequeueMessage({
    messageQueue,
    parentQueue,
    concurrencyLimitKey,
    envConcurrencyLimitKey,
    currentConcurrencyKey,
    envCurrentConcurrencyKey,
  }: {
    messageQueue: string;
    parentQueue: string;
    concurrencyLimitKey: string;
    envConcurrencyLimitKey: string;
    currentConcurrencyKey: string;
    envCurrentConcurrencyKey: string;
  }) {
    const result = await this.redis.dequeueMessage(
      //keys
      messageQueue,
      parentQueue,
      concurrencyLimitKey,
      envConcurrencyLimitKey,
      currentConcurrencyKey,
      envCurrentConcurrencyKey,
      //args
      messageQueue,
      String(Date.now()),
      String(this.options.defaultEnvConcurrency)
    );

    if (!result) {
      return;
    }

    this.logger.debug("Dequeue message result", {
      result,
      service: this.name,
    });

    if (result.length !== 2) {
      this.logger.error("Invalid dequeue message result", {
        result,
        service: this.name,
      });
      return;
    }

    const [messageId, messageScore] = result;

    //read message
    const { orgId } = this.keys.extractComponentsFromQueue(messageQueue);
    const message = await this.readMessage(orgId, messageId);

    if (!message) {
      this.logger.error(`Dequeued then failed to read message. This is unrecoverable.`, {
        messageId,
        messageScore,
        service: this.name,
      });
      return;
    }

    //update task concurrency
    await this.redis.sadd(this.keys.currentTaskIdentifierKey(message), messageId);

    return {
      messageId,
      messageScore,
      message,
    };
  }

  async #callAcknowledgeMessage({
    messageKey,
    messageId,
  }: {
    messageKey: string;
    messageId: string;
  }) {
    this.logger.debug("Calling acknowledgeMessage", {
      messageKey,
      messageId,
      service: this.name,
    });

    // return this.redis.acknowledgeMessage(
    //   parentQueue,
    //   messageKey,
    //   messageQueue,
    //   concurrencyKey,
    //   envConcurrencyKey,
    //   messageId,
    //   messageQueue
    // );
  }

  async #callNackMessage({
    messageKey,
    messageQueue,
    parentQueue,
    concurrencyKey,
    envConcurrencyKey,
    orgConcurrencyKey,
    visibilityQueue,
    messageId,
    messageScore,
  }: {
    messageKey: string;
    messageQueue: string;
    parentQueue: string;
    concurrencyKey: string;
    envConcurrencyKey: string;
    orgConcurrencyKey: string;
    visibilityQueue: string;
    messageId: string;
    messageScore: number;
  }) {
    this.logger.debug("Calling nackMessage", {
      messageKey,
      messageQueue,
      parentQueue,
      concurrencyKey,
      envConcurrencyKey,
      orgConcurrencyKey,
      visibilityQueue,
      messageId,
      messageScore,
      service: this.name,
    });

    return this.redis.nackMessage(
      messageKey,
      messageQueue,
      parentQueue,
      concurrencyKey,
      envConcurrencyKey,
      orgConcurrencyKey,
      visibilityQueue,
      messageQueue,
      messageId,
      String(Date.now()),
      String(messageScore)
    );
  }

  async #callCalculateMessageCapacities({
    currentConcurrencyKey,
    currentEnvConcurrencyKey,

    concurrencyLimitKey,
    envConcurrencyLimitKey,

    disabledConcurrencyLimitKey,
  }: {
    currentConcurrencyKey: string;
    currentEnvConcurrencyKey: string;

    concurrencyLimitKey: string;
    envConcurrencyLimitKey: string;

    disabledConcurrencyLimitKey: string | undefined;
  }): Promise<QueueCapacities> {
    const capacities = disabledConcurrencyLimitKey
      ? await this.redis.calculateMessageQueueCapacitiesWithDisabling(
          currentConcurrencyKey,
          currentEnvConcurrencyKey,
          concurrencyLimitKey,
          envConcurrencyLimitKey,
          disabledConcurrencyLimitKey,
          String(this.options.defaultEnvConcurrency)
        )
      : await this.redis.calculateMessageQueueCapacities(
          currentConcurrencyKey,
          currentEnvConcurrencyKey,
          concurrencyLimitKey,
          envConcurrencyLimitKey,
          String(this.options.defaultEnvConcurrency)
        );

    const queueCurrent = Number(capacities[0]);
    const envLimit = Number(capacities[3]);
    const isOrgEnabled = Boolean(capacities[5]);
    const queueLimit = capacities[1]
      ? Number(capacities[1])
      : Math.min(envLimit, isOrgEnabled ? Infinity : 0);
    const envCurrent = Number(capacities[2]);
    const orgCurrent = Number(capacities[4]);

    return {
      queue: { current: queueCurrent, limit: queueLimit },
      env: { current: envCurrent, limit: envLimit },
    };
  }

  #callUpdateGlobalConcurrencyLimits({
    envConcurrencyLimitKey,
    envConcurrencyLimit,
  }: {
    envConcurrencyLimitKey: string;
    envConcurrencyLimit: number;
  }) {
    return this.redis.updateGlobalConcurrencyLimits(
      envConcurrencyLimitKey,
      String(envConcurrencyLimit)
    );
  }

  async #callRebalanceParentQueueChild({
    parentQueue,
    childQueue,
    currentScore,
  }: {
    parentQueue: string;
    childQueue: string;
    currentScore: string;
  }) {
    const rebalanceResult = await this.redis.rebalanceParentQueueChild(
      childQueue,
      parentQueue,
      childQueue,
      currentScore
    );

    if (rebalanceResult) {
      this.logger.debug("Rebalanced parent queue child", {
        parentQueue,
        childQueue,
        currentScore,
        rebalanceResult,
        operation: "rebalanceParentQueueChild",
        service: this.name,
      });
    }

    return rebalanceResult;
  }

  #registerCommands() {
    this.redis.defineCommand("enqueueMessage", {
      numberOfKeys: 7,
      lua: `
local queue = KEYS[1]
local parentQueue = KEYS[2]
local messageKey = KEYS[3]
local concurrencyKey = KEYS[4]
local envCurrentConcurrencyKey = KEYS[5]
local taskConcurrencyTrackerKey = KEYS[6]
local envConcurrencyTrackerKey = KEYS[7]

local queueName = ARGV[1]
local messageId = ARGV[2]
local messageData = ARGV[3]
local messageScore = ARGV[4]

-- Write the message to the message key
redis.call('SET', messageKey, messageData)

-- Add the message to the queue
redis.call('ZADD', queue, messageScore, messageId)

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', queue, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueue, queueName)
else
    redis.call('ZADD', parentQueue, earliestMessage[2], queueName)
end

-- Update the concurrency keys
redis.call('SREM', concurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)

-- Update concurrency tracking (remove)
redis.call('SREM', taskConcurrencyTrackerKey, messageId)
redis.call('SREM', envConcurrencyTrackerKey, messageId)
      `,
    });

    this.redis.defineCommand("dequeueMessage", {
      numberOfKeys: 6,
      lua: `
local childQueue = KEYS[1]
local parentQueue = KEYS[2]
local concurrencyLimitKey = KEYS[3]
local envConcurrencyLimitKey = KEYS[4]
local currentConcurrencyKey = KEYS[5]
local envCurrentConcurrencyKey = KEYS[6]

local childQueueName = ARGV[1]
local currentTime = tonumber(ARGV[2])
local defaultEnvConcurrencyLimit = ARGV[3]

-- Check current env concurrency against the limit
local envCurrentConcurrency = tonumber(redis.call('SCARD', envCurrentConcurrencyKey) or '0')
local envConcurrencyLimit = tonumber(redis.call('GET', envConcurrencyLimitKey) or defaultEnvConcurrencyLimit)

if envCurrentConcurrency >= envConcurrencyLimit then
    return nil
end

-- Check current queue concurrency against the limit
local currentConcurrency = tonumber(redis.call('SCARD', currentConcurrencyKey) or '0')
local concurrencyLimit = tonumber(redis.call('GET', concurrencyLimitKey) or '1000000')

-- Check condition only if concurrencyLimit exists
if currentConcurrency >= concurrencyLimit then
    return nil
end

-- Attempt to dequeue the next message
local messages = redis.call('ZRANGEBYSCORE', childQueue, '-inf', currentTime, 'WITHSCORES', 'LIMIT', 0, 1)

if #messages == 0 then
    return nil
end

local messageId = messages[1]
local messageScore = tonumber(messages[2])

-- Update concurrency
redis.call('ZREM', childQueue, messageId)
redis.call('SADD', currentConcurrencyKey, messageId)
redis.call('SADD', envCurrentConcurrencyKey, messageId)
redis.call('SADD', taskConcurrencyKey, messageId)

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', childQueue, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueue, childQueueName)
else
    redis.call('ZADD', parentQueue, earliestMessage[2], childQueueName)
end

return {messageId, messageScore} -- Return message details
      `,
    });

    this.redis.defineCommand("acknowledgeMessage", {
      numberOfKeys: 7,
      lua: `
-- Keys: parentQueue, messageKey, messageQueue, visibilityQueue, concurrencyKey, envCurrentConcurrencyKey, orgCurrentConcurrencyKey
local parentQueue = KEYS[1]
local messageKey = KEYS[2]
local messageQueue = KEYS[3]
local visibilityQueue = KEYS[4]
local concurrencyKey = KEYS[5]
local envCurrentConcurrencyKey = KEYS[6]
local orgCurrentConcurrencyKey = KEYS[7]

-- Args: messageId, messageQueueName
local messageId = ARGV[1]
local messageQueueName = ARGV[2]

-- Remove the message from the message key
redis.call('DEL', messageKey)

-- Remove the message from the queue
redis.call('ZREM', messageQueue, messageId)

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', messageQueue, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueue, messageQueueName)
else
    redis.call('ZADD', parentQueue, earliestMessage[2], messageQueueName)
end

-- Remove the message from the timeout queue (deprecated, will eventually remove this)
redis.call('ZREM', visibilityQueue, messageId)

-- Update the concurrency keys
redis.call('SREM', concurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
redis.call('SREM', orgCurrentConcurrencyKey, messageId)
`,
    });

    this.redis.defineCommand("nackMessage", {
      numberOfKeys: 7,
      lua: `
-- Keys: childQueueKey, parentQueueKey, visibilityQueue, concurrencyKey, envConcurrencyKey, orgConcurrencyKey, messageId
local messageKey = KEYS[1]
local childQueueKey = KEYS[2]
local parentQueueKey = KEYS[3]
local concurrencyKey = KEYS[4]
local envConcurrencyKey = KEYS[5]
local orgConcurrencyKey = KEYS[6]
local visibilityQueue = KEYS[7]

-- Args: childQueueName, messageId, currentTime, messageScore
local childQueueName = ARGV[1]
local messageId = ARGV[2]
local currentTime = tonumber(ARGV[3])
local messageScore = tonumber(ARGV[4])

-- Update the concurrency keys
redis.call('SREM', concurrencyKey, messageId)
redis.call('SREM', envConcurrencyKey, messageId)
redis.call('SREM', orgConcurrencyKey, messageId)

-- Check to see if the message is still in the visibilityQueue
local messageVisibility = tonumber(redis.call('ZSCORE', visibilityQueue, messageId)) or 0

if messageVisibility > 0 then
-- Remove the message from the timeout queue (deprecated, will eventually remove this)
    redis.call('ZREM', visibilityQueue, messageId)
end

-- Enqueue the message into the queue
redis.call('ZADD', childQueueKey, messageScore, messageId)

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', childQueueKey, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueueKey, childQueueName)
else
    redis.call('ZADD', parentQueueKey, earliestMessage[2], childQueueName)
end
`,
    });

    this.redis.defineCommand("releaseConcurrency", {
      numberOfKeys: 3,
      lua: `
local concurrencyKey = KEYS[1]
local envCurrentConcurrencyKey = KEYS[2]
local orgCurrentConcurrencyKey = KEYS[3]

local messageId = ARGV[1]

-- Update the concurrency keys
if concurrencyKey ~= "" then
  redis.call('SREM', concurrencyKey, messageId)
end
redis.call('SREM', envCurrentConcurrencyKey, messageId)
redis.call('SREM', orgCurrentConcurrencyKey, messageId)
`,
    });

    this.redis.defineCommand("calculateMessageQueueCapacitiesWithDisabling", {
      numberOfKeys: 5,
      lua: `
-- Keys
local currentConcurrencyKey = KEYS[1]
local currentEnvConcurrencyKey = KEYS[2]
local concurrencyLimitKey = KEYS[4]
local envConcurrencyLimitKey = KEYS[5]
local disabledConcurrencyLimitKey = KEYS[7]

-- Args
local defaultEnvConcurrencyLimit = tonumber(ARGV[1])

-- Check if disabledConcurrencyLimitKey exists
local orgIsEnabled
if redis.call('EXISTS', disabledConcurrencyLimitKey) == 1 then
  orgIsEnabled = false
else
  orgIsEnabled = true
end

local currentEnvConcurrency = tonumber(redis.call('SCARD', currentEnvConcurrencyKey) or '0')
local envConcurrencyLimit = tonumber(redis.call('GET', envConcurrencyLimitKey) or defaultEnvConcurrencyLimit)

local currentConcurrency = tonumber(redis.call('SCARD', currentConcurrencyKey) or '0')
local concurrencyLimit = redis.call('GET', concurrencyLimitKey)

-- Return current capacity and concurrency limits for the queue, env, org
return { currentConcurrency, concurrencyLimit, currentEnvConcurrency, envConcurrencyLimit, currentOrgConcurrency, orgIsEnabled } 
      `,
    });

    this.redis.defineCommand("calculateMessageQueueCapacities", {
      numberOfKeys: 6,
      lua: `
-- Keys:
local currentConcurrencyKey = KEYS[1]
local currentEnvConcurrencyKey = KEYS[2]
local concurrencyLimitKey = KEYS[4]
local envConcurrencyLimitKey = KEYS[5]

-- Args 
local defaultEnvConcurrencyLimit = tonumber(ARGV[1])

local currentEnvConcurrency = tonumber(redis.call('SCARD', currentEnvConcurrencyKey) or '0')
local envConcurrencyLimit = tonumber(redis.call('GET', envConcurrencyLimitKey) or defaultEnvConcurrencyLimit)

local currentConcurrency = tonumber(redis.call('SCARD', currentConcurrencyKey) or '0')
local concurrencyLimit = redis.call('GET', concurrencyLimitKey)

-- Return current capacity and concurrency limits for the queue, env, org
return { currentConcurrency, concurrencyLimit, currentEnvConcurrency, envConcurrencyLimit, currentOrgConcurrency, true } 
      `,
    });

    this.redis.defineCommand("updateGlobalConcurrencyLimits", {
      numberOfKeys: 1,
      lua: `
-- Keys: envConcurrencyLimitKey, orgConcurrencyLimitKey
local envConcurrencyLimitKey = KEYS[1]

-- Args: envConcurrencyLimit, orgConcurrencyLimit
local envConcurrencyLimit = ARGV[1]

redis.call('SET', envConcurrencyLimitKey, envConcurrencyLimit)
      `,
    });

    this.redis.defineCommand("rebalanceParentQueueChild", {
      numberOfKeys: 2,
      lua: `
-- Keys: childQueueKey, parentQueueKey
local childQueueKey = KEYS[1]
local parentQueueKey = KEYS[2]

-- Args: childQueueName, currentScore
local childQueueName = ARGV[1]
local currentScore = ARGV[2]

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', childQueueKey, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueueKey, childQueueName)

    -- Return true because the parent queue was rebalanced
    return true
else
    -- If the earliest message is different, update the parent queue and return true, else return false
    if earliestMessage[2] == currentScore then
        return false
    end

    redis.call('ZADD', parentQueueKey, earliestMessage[2], childQueueName)

    return earliestMessage[2]
end
`,
    });
  }
}

declare module "ioredis" {
  interface RedisCommander<Context> {
    enqueueMessage(
      //keys
      queue: string,
      parentQueue: string,
      messageKey: string,
      concurrencyKey: string,
      envConcurrencyKey: string,
      taskConcurrencyTrackerKey: string,
      environmentConcurrencyTrackerKey: string,
      //args
      queueName: string,
      messageId: string,
      messageData: string,
      messageScore: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    dequeueMessage(
      //keys
      childQueue: string,
      parentQueue: string,
      concurrencyLimitKey: string,
      envConcurrencyLimitKey: string,
      currentConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      //args
      childQueueName: string,
      currentTime: string,
      defaultEnvConcurrencyLimit: string,
      callback?: Callback<[string, string]>
    ): Result<[string, string] | null, Context>;

    acknowledgeMessage(
      parentQueue: string,
      messageKey: string,
      messageQueue: string,
      visibilityQueue: string,
      concurrencyKey: string,
      envConcurrencyKey: string,
      orgConcurrencyKey: string,
      messageId: string,
      messageQueueName: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    nackMessage(
      messageKey: string,
      childQueueKey: string,
      parentQueueKey: string,
      concurrencyKey: string,
      envConcurrencyKey: string,
      orgConcurrencyKey: string,
      visibilityQueue: string,
      childQueueName: string,
      messageId: string,
      currentTime: string,
      messageScore: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    releaseConcurrency(
      concurrencyKey: string,
      envConcurrencyKey: string,
      orgConcurrencyKey: string,
      messageId: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    calculateMessageQueueCapacities(
      currentConcurrencyKey: string,
      currentEnvConcurrencyKey: string,
      concurrencyLimitKey: string,
      envConcurrencyLimitKey: string,
      defaultEnvConcurrencyLimit: string,
      callback?: Callback<number[]>
    ): Result<[number, number, number, number, number, boolean], Context>;

    calculateMessageQueueCapacitiesWithDisabling(
      currentConcurrencyKey: string,
      currentEnvConcurrencyKey: string,
      concurrencyLimitKey: string,
      envConcurrencyLimitKey: string,
      disabledConcurrencyLimitKey: string,
      defaultEnvConcurrencyLimit: string,
      callback?: Callback<number[]>
    ): Result<[number, number, number, number, number, boolean], Context>;

    updateGlobalConcurrencyLimits(
      envConcurrencyLimitKey: string,
      envConcurrencyLimit: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    rebalanceParentQueueChild(
      childQueueKey: string,
      parentQueueKey: string,
      childQueueName: string,
      currentScore: string,
      callback?: Callback<number | string | null>
    ): Result<number | string | null, Context>;
  }
}

// Only allow alphanumeric characters, underscores, hyphens, and slashes (and only the first 128 characters)
export function sanitizeQueueName(queueName: string) {
  return queueName.replace(/[^a-zA-Z0-9_\-\/]/g, "").substring(0, 128);
}
