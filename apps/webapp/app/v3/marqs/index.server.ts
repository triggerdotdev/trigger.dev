import {
  Span,
  SpanKind,
  SpanOptions,
  Tracer,
  context,
  propagation,
  trace,
} from "@opentelemetry/api";
import {
  SEMATTRS_MESSAGE_ID,
  SEMATTRS_MESSAGING_OPERATION,
  SEMATTRS_MESSAGING_SYSTEM,
} from "@opentelemetry/semantic-conventions";
import { flattenAttributes } from "@trigger.dev/core/v3";
import Redis, { type Callback, type RedisOptions, type Result } from "ioredis";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { attributesFromAuthenticatedEnv } from "../tracer.server";
import { AsyncWorker } from "./asyncWorker.server";
import { MarQSShortKeyProducer } from "./marqsKeyProducer.server";
import { SimpleWeightedChoiceStrategy } from "./simpleWeightedPriorityStrategy.server";
import {
  MarQSKeyProducer,
  MarQSQueuePriorityStrategy,
  MessagePayload,
  QueueCapacities,
  QueueRange,
  VisibilityTimeoutStrategy,
} from "./types";
import { V3VisibilityTimeout } from "./v3VisibilityTimeout.server";

const KEY_PREFIX = "marqs:";

const constants = {
  MESSAGE_VISIBILITY_TIMEOUT_QUEUE: "msgVisibilityTimeout",
} as const;

const SemanticAttributes = {
  QUEUE: "marqs.queue",
  PARENT_QUEUE: "marqs.parentQueue",
  MESSAGE_ID: "marqs.messageId",
  CONCURRENCY_KEY: "marqs.concurrencyKey",
};

export type MarQSOptions = {
  name: string;
  tracer: Tracer;
  redis: RedisOptions;
  defaultEnvConcurrency: number;
  defaultOrgConcurrency: number;
  windowSize?: number;
  visibilityTimeoutInMs?: number;
  workers: number;
  keysProducer: MarQSKeyProducer;
  queuePriorityStrategy: MarQSQueuePriorityStrategy;
  envQueuePriorityStrategy: MarQSQueuePriorityStrategy;
  visibilityTimeoutStrategy: VisibilityTimeoutStrategy;
  enableRebalancing?: boolean;
  verbose?: boolean;
};

/**
 * MarQS - Multitenant Asynchronous Reliable Queueing System (pronounced "markus")
 */
export class MarQS {
  private redis: Redis;
  public keys: MarQSKeyProducer;
  private queuePriorityStrategy: MarQSQueuePriorityStrategy;
  #rebalanceWorkers: Array<AsyncWorker> = [];

  constructor(private readonly options: MarQSOptions) {
    this.redis = new Redis(options.redis);

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

  public async updateEnvConcurrencyLimits(env: AuthenticatedEnvironment) {
    await this.#callUpdateGlobalConcurrencyLimits({
      envConcurrencyLimitKey: this.keys.envConcurrencyLimitKey(env),
      orgConcurrencyLimitKey: this.keys.orgConcurrencyLimitKey(env),
      envConcurrencyLimit: env.maximumConcurrencyLimit,
      orgConcurrencyLimit: env.organization.maximumConcurrencyLimit,
    });
  }

  public async getQueueConcurrencyLimit(env: AuthenticatedEnvironment, queue: string) {
    const result = await this.redis.get(this.keys.queueConcurrencyLimitKey(env, queue));

    return result ? Number(result) : undefined;
  }

  public async getEnvConcurrencyLimit(env: AuthenticatedEnvironment) {
    const result = await this.redis.get(this.keys.envConcurrencyLimitKey(env));

    return result ? Number(result) : this.options.defaultEnvConcurrency;
  }

  public async getOrgConcurrencyLimit(env: AuthenticatedEnvironment) {
    const result = await this.redis.get(this.keys.orgConcurrencyLimitKey(env));

    return result ? Number(result) : this.options.defaultOrgConcurrency;
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

  public async currentConcurrencyOfOrg(env: AuthenticatedEnvironment) {
    return this.redis.scard(this.keys.orgCurrentConcurrencyKey(env));
  }

  public async enqueueMessage(
    env: AuthenticatedEnvironment,
    queue: string,
    messageId: string,
    messageData: Record<string, unknown>,
    concurrencyKey?: string,
    timestamp?: number
  ) {
    return await this.#trace(
      "enqueueMessage",
      async (span) => {
        const messageQueue = this.keys.queueKey(env, queue, concurrencyKey);

        const parentQueue = this.keys.envSharedQueueKey(env);

        propagation.inject(context.active(), messageData);

        const messagePayload: MessagePayload = {
          version: "1",
          data: messageData,
          queue: messageQueue,
          concurrencyKey,
          timestamp: timestamp ?? Date.now(),
          messageId,
          parentQueue,
        };

        span.setAttributes({
          [SemanticAttributes.QUEUE]: queue,
          [SemanticAttributes.MESSAGE_ID]: messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: concurrencyKey,
          [SemanticAttributes.PARENT_QUEUE]: parentQueue,
        });

        await this.#callEnqueueMessage(messagePayload);
      },
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "publish",
          [SEMATTRS_MESSAGE_ID]: messageId,
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
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

        const messageData = await this.#callDequeueMessage({
          messageQueue,
          parentQueue,
          visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
          concurrencyLimitKey: this.keys.concurrencyLimitKeyFromQueue(messageQueue),
          currentConcurrencyKey: this.keys.currentConcurrencyKeyFromQueue(messageQueue),
          envConcurrencyLimitKey: this.keys.envConcurrencyLimitKeyFromQueue(messageQueue),
          envCurrentConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(messageQueue),
          orgConcurrencyLimitKey: this.keys.orgConcurrencyLimitKeyFromQueue(messageQueue),
          orgCurrentConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(messageQueue),
        });

        if (!messageData) {
          return;
        }

        const message = await this.readMessage(messageData.messageId);

        if (message) {
          span.setAttributes({
            [SEMATTRS_MESSAGE_ID]: message.messageId,
            [SemanticAttributes.QUEUE]: message.queue,
            [SemanticAttributes.MESSAGE_ID]: message.messageId,
            [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
            [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
          });
        } else {
          logger.error(`Failed to read message, undoing the dequeueing of the message`, {
            messageData,
            service: this.name,
          });

          await this.#callAcknowledgeMessage({
            parentQueue,
            messageKey: this.keys.messageKey(messageData.messageId),
            messageQueue: messageQueue,
            visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
            concurrencyKey: this.keys.currentConcurrencyKeyFromQueue(messageQueue),
            envConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(messageQueue),
            orgConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(messageQueue),
            messageId: messageData.messageId,
          });
        }

        await this.options.visibilityTimeoutStrategy.heartbeat(
          messageData.messageId,
          this.visibilityTimeoutInMs
        );

        return message;
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "receive",
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
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
        const messageData = await this.#callDequeueMessage({
          messageQueue,
          parentQueue,
          visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
          concurrencyLimitKey: this.keys.concurrencyLimitKeyFromQueue(messageQueue),
          currentConcurrencyKey: this.keys.currentConcurrencyKeyFromQueue(messageQueue),
          envConcurrencyLimitKey: this.keys.envConcurrencyLimitKeyFromQueue(messageQueue),
          envCurrentConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(messageQueue),
          orgConcurrencyLimitKey: this.keys.orgConcurrencyLimitKeyFromQueue(messageQueue),
          orgCurrentConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(messageQueue),
        });

        if (!messageData) {
          return;
        }

        const message = await this.readMessage(messageData.messageId);

        if (message) {
          span.setAttributes({
            [SEMATTRS_MESSAGE_ID]: message.messageId,
            [SemanticAttributes.QUEUE]: message.queue,
            [SemanticAttributes.MESSAGE_ID]: message.messageId,
            [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
            [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
          });
        }

        await this.options.visibilityTimeoutStrategy.heartbeat(
          messageData.messageId,
          this.visibilityTimeoutInMs
        );

        return message;
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "receive",
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
        },
      }
    );
  }

  public async acknowledgeMessage(messageId: string) {
    return this.#trace(
      "acknowledgeMessage",
      async (span) => {
        const message = await this.readMessage(messageId);

        if (!message) {
          return;
        }

        span.setAttributes({
          [SemanticAttributes.QUEUE]: message.queue,
          [SemanticAttributes.MESSAGE_ID]: message.messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
          [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
        });

        await this.options.visibilityTimeoutStrategy.cancelHeartbeat(messageId);

        await this.#callAcknowledgeMessage({
          parentQueue: message.parentQueue,
          messageKey: this.keys.messageKey(messageId),
          messageQueue: message.queue,
          visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
          concurrencyKey: this.keys.currentConcurrencyKeyFromQueue(message.queue),
          envConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(message.queue),
          orgConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(message.queue),
          messageId,
        });
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "ack",
          [SEMATTRS_MESSAGE_ID]: messageId,
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
        },
      }
    );
  }

  public async replaceMessage(
    messageId: string,
    messageData: Record<string, unknown>,
    timestamp?: number,
    inplace?: boolean
  ) {
    return this.#trace(
      "replaceMessage",
      async (span) => {
        const oldMessage = await this.readMessage(messageId);

        if (!oldMessage) {
          return;
        }

        span.setAttributes({
          [SemanticAttributes.QUEUE]: oldMessage.queue,
          [SemanticAttributes.MESSAGE_ID]: oldMessage.messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: oldMessage.concurrencyKey,
          [SemanticAttributes.PARENT_QUEUE]: oldMessage.parentQueue,
        });

        const traceContext = {
          traceparent: oldMessage.data.traceparent,
          tracestate: oldMessage.data.tracestate,
        };

        const newMessage: MessagePayload = {
          version: "1",
          // preserve original trace context
          data: { ...messageData, ...traceContext },
          queue: oldMessage.queue,
          concurrencyKey: oldMessage.concurrencyKey,
          timestamp: timestamp ?? Date.now(),
          messageId,
          parentQueue: oldMessage.parentQueue,
        };

        if (inplace) {
          await this.#callReplaceMessage(newMessage);
          return;
        }

        await this.options.visibilityTimeoutStrategy.cancelHeartbeat(messageId);

        await this.#callAcknowledgeMessage({
          parentQueue: oldMessage.parentQueue,
          messageKey: this.keys.messageKey(messageId),
          messageQueue: oldMessage.queue,
          visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
          concurrencyKey: this.keys.currentConcurrencyKeyFromQueue(oldMessage.queue),
          envConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(oldMessage.queue),
          orgConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(oldMessage.queue),
          messageId,
        });

        await this.#callEnqueueMessage(newMessage);
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "replace",
          [SEMATTRS_MESSAGE_ID]: messageId,
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
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
        const message = await this.readMessage(messageId);

        if (!message) {
          return;
        }

        span.setAttributes({
          [SemanticAttributes.QUEUE]: message.queue,
          [SemanticAttributes.MESSAGE_ID]: message.messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
          [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
        });

        if (updates) {
          await this.replaceMessage(messageId, updates, retryAt, true);
        }

        await this.options.visibilityTimeoutStrategy.cancelHeartbeat(messageId);

        await this.#callNackMessage({
          messageKey: this.keys.messageKey(messageId),
          messageQueue: message.queue,
          parentQueue: message.parentQueue,
          concurrencyKey: this.keys.currentConcurrencyKeyFromQueue(message.queue),
          envConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(message.queue),
          orgConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(message.queue),
          visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
          messageId,
          messageScore: retryAt,
        });
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "nack",
          [SEMATTRS_MESSAGE_ID]: messageId,
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
        },
      }
    );
  }

  // This should increment by the number of seconds, but with a max value of Date.now() + visibilityTimeoutInMs
  public async heartbeatMessage(messageId: string, seconds: number = 30) {
    await this.options.visibilityTimeoutStrategy.heartbeat(messageId, seconds * 1000);
  }

  get visibilityTimeoutInMs() {
    return this.options.visibilityTimeoutInMs ?? 300000; // 5 minutes
  }

  async readMessage(messageId: string) {
    return this.#trace(
      "readMessage",
      async (span) => {
        const rawMessage = await this.redis.get(this.keys.messageKey(messageId));

        if (!rawMessage) {
          return;
        }

        const message = MessagePayload.safeParse(JSON.parse(rawMessage));

        if (!message.success) {
          logger.error(`[${this.name}] Failed to parse message`, {
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
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
          [SemanticAttributes.MESSAGE_ID]: messageId,
        },
      }
    );
  }

  async #getRandomQueueFromParentQueue(
    parentQueue: string,
    queuePriorityStrategy: MarQSQueuePriorityStrategy,
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
          ...flattenAttributes(queues, "marqs.queues"),
        });
        span.setAttributes({
          ...flattenAttributes(queuesWithScores, "marqs.queuesWithScores"),
        });
        span.setAttribute("range.offset", range.offset);
        span.setAttribute("range.count", range.count);
        span.setAttribute("nextRange.offset", nextRange.offset);
        span.setAttribute("nextRange.count", nextRange.count);

        if (this.options.verbose || nextRange.offset > 0) {
          if (typeof choice === "string") {
            logger.debug(`[${this.name}] getRandomQueueFromParentQueue`, {
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
            logger.debug(`[${this.name}] getRandomQueueFromParentQueue`, {
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
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
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
      currentOrgConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(queue),
      concurrencyLimitKey: this.keys.concurrencyLimitKeyFromQueue(queue),
      envConcurrencyLimitKey: this.keys.envConcurrencyLimitKeyFromQueue(queue),
      orgConcurrencyLimitKey: this.keys.orgConcurrencyLimitKeyFromQueue(queue),
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

    logger.debug("Starting queue concurrency scan stream", {
      pattern,
      component: "marqs",
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

      logger.debug("Streaming parent queues based on pattern", {
        pattern,
        component: "marqs",
        operation: "rebalanceParentQueues",
        service: this.name,
      });

      stream.on("data", async (keys) => {
        const uniqueKeys = Array.from(new Set<string>(keys));

        if (uniqueKeys.length === 0) {
          return;
        }

        stream.pause();

        logger.debug("Rebalancing parent queues", {
          component: "marqs",
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

        logger.debug("Rebalancing child queues", {
          parentQueue,
          childQueuesWithScores,
          component: "marqs",
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
    logger.debug("Calling enqueueMessage", {
      messagePayload: message,
      service: this.name,
    });

    return this.redis.enqueueMessage(
      message.queue,
      message.parentQueue,
      this.keys.messageKey(message.messageId),
      message.queue,
      message.messageId,
      JSON.stringify(message),
      String(message.timestamp)
    );
  }

  async #callDequeueMessage({
    messageQueue,
    parentQueue,
    visibilityQueue,
    concurrencyLimitKey,
    envConcurrencyLimitKey,
    orgConcurrencyLimitKey,
    currentConcurrencyKey,
    envCurrentConcurrencyKey,
    orgCurrentConcurrencyKey,
  }: {
    messageQueue: string;
    parentQueue: string;
    visibilityQueue: string;
    concurrencyLimitKey: string;
    envConcurrencyLimitKey: string;
    orgConcurrencyLimitKey: string;
    currentConcurrencyKey: string;
    envCurrentConcurrencyKey: string;
    orgCurrentConcurrencyKey: string;
  }) {
    const result = await this.redis.dequeueMessage(
      messageQueue,
      parentQueue,
      concurrencyLimitKey,
      envConcurrencyLimitKey,
      orgConcurrencyLimitKey,
      currentConcurrencyKey,
      envCurrentConcurrencyKey,
      orgCurrentConcurrencyKey,
      messageQueue,
      String(Date.now()),
      String(this.options.defaultEnvConcurrency),
      String(this.options.defaultOrgConcurrency)
    );

    if (!result) {
      return;
    }

    logger.debug("Dequeue message result", {
      result,
      service: this.name,
    });

    if (result.length !== 2) {
      return;
    }

    return {
      messageId: result[0],
      messageScore: result[1],
    };
  }

  async #callReplaceMessage(message: MessagePayload) {
    logger.debug("Calling replaceMessage", {
      messagePayload: message,
      service: this.name,
    });

    return this.redis.replaceMessage(
      this.keys.messageKey(message.messageId),
      JSON.stringify(message)
    );
  }

  async #callAcknowledgeMessage({
    parentQueue,
    messageKey,
    messageQueue,
    visibilityQueue,
    concurrencyKey,
    envConcurrencyKey,
    orgConcurrencyKey,
    messageId,
  }: {
    parentQueue: string;
    messageKey: string;
    messageQueue: string;
    visibilityQueue: string;
    concurrencyKey: string;
    envConcurrencyKey: string;
    orgConcurrencyKey: string;
    messageId: string;
  }) {
    logger.debug("Calling acknowledgeMessage", {
      messageKey,
      messageQueue,
      visibilityQueue,
      concurrencyKey,
      envConcurrencyKey,
      orgConcurrencyKey,
      messageId,
      parentQueue,
      service: this.name,
    });

    return this.redis.acknowledgeMessage(
      parentQueue,
      messageKey,
      messageQueue,
      visibilityQueue,
      concurrencyKey,
      envConcurrencyKey,
      orgConcurrencyKey,
      messageId,
      messageQueue
    );
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
    logger.debug("Calling nackMessage", {
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
    currentOrgConcurrencyKey,
    concurrencyLimitKey,
    envConcurrencyLimitKey,
    orgConcurrencyLimitKey,
    disabledConcurrencyLimitKey,
  }: {
    currentConcurrencyKey: string;
    currentEnvConcurrencyKey: string;
    currentOrgConcurrencyKey: string;
    concurrencyLimitKey: string;
    envConcurrencyLimitKey: string;
    orgConcurrencyLimitKey: string;
    disabledConcurrencyLimitKey: string | undefined;
  }): Promise<QueueCapacities> {
    const capacities = disabledConcurrencyLimitKey
      ? await this.redis.calculateMessageQueueCapacitiesWithDisabling(
          currentConcurrencyKey,
          currentEnvConcurrencyKey,
          currentOrgConcurrencyKey,
          concurrencyLimitKey,
          envConcurrencyLimitKey,
          orgConcurrencyLimitKey,
          disabledConcurrencyLimitKey,
          String(this.options.defaultEnvConcurrency),
          String(this.options.defaultOrgConcurrency)
        )
      : await this.redis.calculateMessageQueueCapacities(
          currentConcurrencyKey,
          currentEnvConcurrencyKey,
          currentOrgConcurrencyKey,
          concurrencyLimitKey,
          envConcurrencyLimitKey,
          orgConcurrencyLimitKey,
          String(this.options.defaultEnvConcurrency),
          String(this.options.defaultOrgConcurrency)
        );

    const queueCurrent = Number(capacities[0]);
    const envLimit = Number(capacities[3]);
    const orgLimit = Number(capacities[5]);
    const queueLimit = capacities[1] ? Number(capacities[1]) : Math.min(envLimit, orgLimit);
    const envCurrent = Number(capacities[2]);
    const orgCurrent = Number(capacities[4]);

    // [queue current, queue limit, env current, env limit, org current, org limit]
    return {
      queue: { current: queueCurrent, limit: queueLimit },
      env: { current: envCurrent, limit: envLimit },
      org: { current: orgCurrent, limit: orgLimit },
    };
  }

  #callUpdateGlobalConcurrencyLimits({
    envConcurrencyLimitKey,
    orgConcurrencyLimitKey,
    envConcurrencyLimit,
    orgConcurrencyLimit,
  }: {
    envConcurrencyLimitKey: string;
    orgConcurrencyLimitKey: string;
    envConcurrencyLimit: number;
    orgConcurrencyLimit: number;
  }) {
    return this.redis.updateGlobalConcurrencyLimits(
      envConcurrencyLimitKey,
      orgConcurrencyLimitKey,
      String(envConcurrencyLimit),
      String(orgConcurrencyLimit)
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
      logger.debug("Rebalanced parent queue child", {
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
      numberOfKeys: 3,
      lua: `
local queue = KEYS[1]
local parentQueue = KEYS[2]
local messageKey = KEYS[3]

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
      `,
    });

    this.redis.defineCommand("dequeueMessage", {
      numberOfKeys: 8,
      lua: `
-- Keys: childQueue, parentQueue, concurrencyLimitKey, envConcurrencyLimitKey, orgConcurrencyLimitKey, currentConcurrencyKey, envCurrentConcurrencyKey, orgCurrentConcurrencyKey
local childQueue = KEYS[1]
local parentQueue = KEYS[2]
local concurrencyLimitKey = KEYS[3]
local envConcurrencyLimitKey = KEYS[4]
local orgConcurrencyLimitKey = KEYS[5]
local currentConcurrencyKey = KEYS[6]
local envCurrentConcurrencyKey = KEYS[7]
local orgCurrentConcurrencyKey = KEYS[8]

-- Args: childQueueName, currentTime, defaultEnvConcurrencyLimit, defaultOrgConcurrencyLimit
local childQueueName = ARGV[1]
local currentTime = tonumber(ARGV[2])
local defaultEnvConcurrencyLimit = ARGV[3]
local defaultOrgConcurrencyLimit = ARGV[4]

-- Check current org concurrency against the limit
local orgCurrentConcurrency = tonumber(redis.call('SCARD', orgCurrentConcurrencyKey) or '0')
local orgConcurrencyLimit = tonumber(redis.call('GET', orgConcurrencyLimitKey) or defaultOrgConcurrencyLimit)

if orgCurrentConcurrency >= orgConcurrencyLimit then
    return nil
end

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

-- Move message to timeout queue and update concurrency
redis.call('ZREM', childQueue, messageId)
redis.call('SADD', currentConcurrencyKey, messageId)
redis.call('SADD', envCurrentConcurrencyKey, messageId)
redis.call('SADD', orgCurrentConcurrencyKey, messageId)

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

    this.redis.defineCommand("replaceMessage", {
      numberOfKeys: 1,
      lua: `
local messageKey = KEYS[1]
local messageData = ARGV[1]

-- Check if message exists
local existingMessage = redis.call('GET', messageKey)

-- Do nothing if it doesn't
if #existingMessage == nil then
    return nil
end

-- Replace the message
redis.call('SET', messageKey, messageData, 'GET')
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

    this.redis.defineCommand("heartbeatMessage", {
      numberOfKeys: 1,
      lua: `
-- Keys: visibilityQueue
local visibilityQueue = KEYS[1]

-- Args: messageId, milliseconds, maxVisibilityTimeout
local messageId = ARGV[1]
local milliseconds = tonumber(ARGV[2])
local maxVisibilityTimeout = tonumber(ARGV[3])

-- Get the current visibility timeout
local zscoreResult = redis.call('ZSCORE', visibilityQueue, messageId)

-- If there's no currentVisibilityTimeout, return and do not execute ZADD
if zscoreResult == false then
    return
end

local currentVisibilityTimeout = tonumber(zscoreResult)


-- Calculate the new visibility timeout
local newVisibilityTimeout = math.min(currentVisibilityTimeout + milliseconds * 1000, maxVisibilityTimeout)

-- Update the visibility timeout
redis.call('ZADD', visibilityQueue, newVisibilityTimeout, messageId)
      `,
    });

    this.redis.defineCommand("calculateMessageQueueCapacitiesWithDisabling", {
      numberOfKeys: 7,
      lua: `
-- Keys: currentConcurrencyKey, currentEnvConcurrencyKey, currentOrgConcurrencyKey, concurrencyLimitKey, envConcurrencyLimitKey, orgConcurrencyLimitKey, disabledConcurrencyLimitKey
local currentConcurrencyKey = KEYS[1]
local currentEnvConcurrencyKey = KEYS[2]
local currentOrgConcurrencyKey = KEYS[3]
local concurrencyLimitKey = KEYS[4]
local envConcurrencyLimitKey = KEYS[5]
local orgConcurrencyLimitKey = KEYS[6]
local disabledConcurrencyLimitKey = KEYS[7]

-- Args defaultEnvConcurrencyLimit, defaultOrgConcurrencyLimit
local defaultEnvConcurrencyLimit = tonumber(ARGV[1])
local defaultOrgConcurrencyLimit = tonumber(ARGV[2])

local currentOrgConcurrency = tonumber(redis.call('SCARD', currentOrgConcurrencyKey) or '0')

-- Check if disabledConcurrencyLimitKey exists
local orgConcurrencyLimit
if redis.call('EXISTS', disabledConcurrencyLimitKey) == 1 then
  orgConcurrencyLimit = 0
else
  orgConcurrencyLimit = tonumber(redis.call('GET', orgConcurrencyLimitKey) or defaultOrgConcurrencyLimit)
end

local currentEnvConcurrency = tonumber(redis.call('SCARD', currentEnvConcurrencyKey) or '0')
local envConcurrencyLimit = tonumber(redis.call('GET', envConcurrencyLimitKey) or defaultEnvConcurrencyLimit)

local currentConcurrency = tonumber(redis.call('SCARD', currentConcurrencyKey) or '0')
local concurrencyLimit = redis.call('GET', concurrencyLimitKey)

-- Return current capacity and concurrency limits for the queue, env, org
return { currentConcurrency, concurrencyLimit, currentEnvConcurrency, envConcurrencyLimit, currentOrgConcurrency, orgConcurrencyLimit } 
      `,
    });

    this.redis.defineCommand("calculateMessageQueueCapacities", {
      numberOfKeys: 6,
      lua: `
-- Keys: currentConcurrencyKey, currentEnvConcurrencyKey, currentOrgConcurrencyKey, concurrencyLimitKey, envConcurrencyLimitKey, orgConcurrencyLimitKey
local currentConcurrencyKey = KEYS[1]
local currentEnvConcurrencyKey = KEYS[2]
local currentOrgConcurrencyKey = KEYS[3]
local concurrencyLimitKey = KEYS[4]
local envConcurrencyLimitKey = KEYS[5]
local orgConcurrencyLimitKey = KEYS[6]

-- Args defaultEnvConcurrencyLimit, defaultOrgConcurrencyLimit
local defaultEnvConcurrencyLimit = tonumber(ARGV[1])
local defaultOrgConcurrencyLimit = tonumber(ARGV[2])

local currentOrgConcurrency = tonumber(redis.call('SCARD', currentOrgConcurrencyKey) or '0')
local orgConcurrencyLimit = tonumber(redis.call('GET', orgConcurrencyLimitKey) or defaultOrgConcurrencyLimit)

local currentEnvConcurrency = tonumber(redis.call('SCARD', currentEnvConcurrencyKey) or '0')
local envConcurrencyLimit = tonumber(redis.call('GET', envConcurrencyLimitKey) or defaultEnvConcurrencyLimit)

local currentConcurrency = tonumber(redis.call('SCARD', currentConcurrencyKey) or '0')
local concurrencyLimit = redis.call('GET', concurrencyLimitKey)

-- Return current capacity and concurrency limits for the queue, env, org
return { currentConcurrency, concurrencyLimit, currentEnvConcurrency, envConcurrencyLimit, currentOrgConcurrency, orgConcurrencyLimit } 
      `,
    });

    this.redis.defineCommand("updateGlobalConcurrencyLimits", {
      numberOfKeys: 2,
      lua: `
-- Keys: envConcurrencyLimitKey, orgConcurrencyLimitKey
local envConcurrencyLimitKey = KEYS[1]
local orgConcurrencyLimitKey = KEYS[2]

-- Args: envConcurrencyLimit, orgConcurrencyLimit
local envConcurrencyLimit = ARGV[1]
local orgConcurrencyLimit = ARGV[2]

redis.call('SET', envConcurrencyLimitKey, envConcurrencyLimit)
redis.call('SET', orgConcurrencyLimitKey, orgConcurrencyLimit)
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
      queue: string,
      parentQueue: string,
      messageKey: string,
      queueName: string,
      messageId: string,
      messageData: string,
      messageScore: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    dequeueMessage(
      childQueue: string,
      parentQueue: string,
      concurrencyLimitKey: string,
      envConcurrencyLimitKey: string,
      orgConcurrencyLimitKey: string,
      currentConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      orgCurrentConcurrencyKey: string,
      childQueueName: string,
      currentTime: string,
      defaultEnvConcurrencyLimit: string,
      defaultOrgConcurrencyLimit: string,
      callback?: Callback<[string, string]>
    ): Result<[string, string] | null, Context>;

    replaceMessage(
      messageKey: string,
      messageData: string,
      callback?: Callback<void>
    ): Result<void, Context>;

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

    heartbeatMessage(
      visibilityQueue: string,
      messageId: string,
      milliseconds: string,
      maxVisibilityTimeout: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    calculateMessageQueueCapacities(
      currentConcurrencyKey: string,
      currentEnvConcurrencyKey: string,
      currentOrgConcurrencyKey: string,
      concurrencyLimitKey: string,
      envConcurrencyLimitKey: string,
      orgConcurrencyLimitKey: string,
      defaultEnvConcurrencyLimit: string,
      defaultOrgConcurrencyLimit: string,
      callback?: Callback<number[]>
    ): Result<number[], Context>;

    calculateMessageQueueCapacitiesWithDisabling(
      currentConcurrencyKey: string,
      currentEnvConcurrencyKey: string,
      currentOrgConcurrencyKey: string,
      concurrencyLimitKey: string,
      envConcurrencyLimitKey: string,
      orgConcurrencyLimitKey: string,
      disabledConcurrencyLimitKey: string,
      defaultEnvConcurrencyLimit: string,
      defaultOrgConcurrencyLimit: string,
      callback?: Callback<number[]>
    ): Result<number[], Context>;

    updateGlobalConcurrencyLimits(
      envConcurrencyLimitKey: string,
      orgConcurrencyLimitKey: string,
      envConcurrencyLimit: string,
      orgConcurrencyLimit: string,
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

export const marqs = singleton("marqs", getMarQSClient);

function getMarQSClient() {
  if (env.V3_ENABLED) {
    if (env.REDIS_HOST && env.REDIS_PORT) {
      const redisOptions = {
        keyPrefix: KEY_PREFIX,
        port: env.REDIS_PORT,
        host: env.REDIS_HOST,
        username: env.REDIS_USERNAME,
        password: env.REDIS_PASSWORD,
        enableAutoPipelining: true,
        ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
      };

      return new MarQS({
        name: "marqs",
        tracer: trace.getTracer("marqs"),
        keysProducer: new MarQSShortKeyProducer(KEY_PREFIX),
        visibilityTimeoutStrategy: new V3VisibilityTimeout(),
        queuePriorityStrategy: new SimpleWeightedChoiceStrategy({ queueSelectionCount: 36 }),
        envQueuePriorityStrategy: new SimpleWeightedChoiceStrategy({ queueSelectionCount: 12 }),
        workers: 1,
        redis: redisOptions,
        defaultEnvConcurrency: env.DEFAULT_ENV_EXECUTION_CONCURRENCY_LIMIT,
        defaultOrgConcurrency: env.DEFAULT_ORG_EXECUTION_CONCURRENCY_LIMIT,
        visibilityTimeoutInMs: 120 * 1000, // 2 minutes,
        enableRebalancing: !env.MARQS_DISABLE_REBALANCING,
      });
    } else {
      console.warn(
        "Could not initialize MarQS because process.env.REDIS_HOST and process.env.REDIS_PORT are required to be set. Trigger.dev v3 will not work without this."
      );
    }
  }
}

// Only allow alphanumeric characters, underscores, hyphens, and slashes (and only the first 128 characters)
export function sanitizeQueueName(queueName: string) {
  return queueName.replace(/[^a-zA-Z0-9_\-\/]/g, "").substring(0, 128);
}
