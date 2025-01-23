import {
  context,
  propagation,
  Span,
  SpanKind,
  SpanOptions,
  SpanStatusCode,
  trace,
  Tracer,
} from "@opentelemetry/api";
import {
  SEMATTRS_MESSAGE_ID,
  SEMATTRS_MESSAGING_OPERATION,
  SEMATTRS_MESSAGING_SYSTEM,
} from "@opentelemetry/semantic-conventions";
import Redis, { type Callback, type Result } from "ioredis";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { concurrencyTracker } from "../services/taskRunConcurrencyTracker.server";
import { attributesFromAuthenticatedEnv, tracer } from "../tracer.server";
import { AsyncWorker } from "./asyncWorker.server";
import { FairDequeuingStrategy } from "./fairDequeuingStrategy.server";
import { MarQSShortKeyProducer } from "./marqsKeyProducer.server";
import {
  MarQSFairDequeueStrategy,
  MarQSKeyProducer,
  MessagePayload,
  MessageQueueSubscriber,
  VisibilityTimeoutStrategy,
} from "./types";
import { V3VisibilityTimeout } from "./v3VisibilityTimeout.server";

const KEY_PREFIX = "marqs:";

const SemanticAttributes = {
  CONSUMER_ID: "consumer_id",
  QUEUE: "queue",
  PARENT_QUEUE: "parent_queue",
  MESSAGE_ID: "message_id",
  CONCURRENCY_KEY: "concurrency_key",
};

export type MarQSOptions = {
  name: string;
  tracer: Tracer;
  redis: Redis;
  defaultEnvConcurrency: number;
  defaultOrgConcurrency: number;
  windowSize?: number;
  visibilityTimeoutInMs?: number;
  workers: number;
  keysProducer: MarQSKeyProducer;
  queuePriorityStrategy: MarQSFairDequeueStrategy;
  envQueuePriorityStrategy: MarQSFairDequeueStrategy;
  visibilityTimeoutStrategy: VisibilityTimeoutStrategy;
  maximumNackCount: number;
  enableRebalancing?: boolean;
  verbose?: boolean;
  subscriber?: MessageQueueSubscriber;
};

/**
 * MarQS - Multitenant Asynchronous Reliable Queueing System (pronounced "markus")
 */
export class MarQS {
  private redis: Redis;
  public keys: MarQSKeyProducer;
  #rebalanceWorkers: Array<AsyncWorker> = [];

  private _staleQueues: Set<string> = new Set();
  private _staleQueueHits: Map<string, number> = new Map();

  constructor(private readonly options: MarQSOptions) {
    this.redis = options.redis;

    this.keys = options.keysProducer;

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

  public async lengthOfEnvQueue(env: AuthenticatedEnvironment) {
    return this.redis.zcard(this.keys.envQueueKey(env));
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

        await this.options.subscriber?.messageEnqueued(messagePayload);
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

        span.setAttribute(SemanticAttributes.PARENT_QUEUE, parentQueue);
        span.setAttribute(SemanticAttributes.CONSUMER_ID, env.id);

        // Get prioritized list of queues to try
        const queues =
          await this.options.envQueuePriorityStrategy.distributeFairQueuesFromParentQueue(
            parentQueue,
            env.id
          );

        span.setAttribute("queue_count", queues.length);

        for (const messageQueue of queues) {
          const messageData = await this.#callDequeueMessage({
            messageQueue,
            parentQueue,
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
              attempted_queues: queues.indexOf(messageQueue) + 1, // How many queues we tried before success
              message_timestamp: message.timestamp,
              message_age: Date.now() - message.timestamp,
            });

            await this.options.subscriber?.messageDequeued(message);
          } else {
            logger.error(`Failed to read message, undoing the dequeueing of the message`, {
              messageData,
              service: this.name,
            });

            await this.#callAcknowledgeMessage({
              parentQueue,
              messageKey: this.keys.messageKey(messageData.messageId),
              messageQueue: messageQueue,
              concurrencyKey: this.keys.currentConcurrencyKeyFromQueue(messageQueue),
              envConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(messageQueue),
              orgConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(messageQueue),
              messageId: messageData.messageId,
            });

            return;
          }

          await this.options.visibilityTimeoutStrategy.heartbeat(
            messageData.messageId,
            this.visibilityTimeoutInMs
          );

          return message;
        }

        span.setAttribute("attempted_queues", queues.length);
        return;
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

  /**
   * Dequeue a message from the shared queue (this should be used in production environments)
   */
  public async dequeueMessageInSharedQueue(consumerId: string) {
    return this.#trace(
      "dequeueMessageInSharedQueue",
      async (span) => {
        span.setAttribute(SemanticAttributes.CONSUMER_ID, consumerId);

        const parentQueue = this.keys.sharedQueueKey();

        span.setAttribute(SemanticAttributes.PARENT_QUEUE, parentQueue);

        // Get prioritized list of queues to try
        const queues = await this.options.queuePriorityStrategy.distributeFairQueuesFromParentQueue(
          parentQueue,
          consumerId
        );

        span.setAttribute("queue_count", queues.length);

        if (queues.length === 0) {
          return;
        }

        // Try each queue in order until we successfully dequeue a message
        for (const messageQueue of queues) {
          try {
            const messageData = await this.#callDequeueMessage({
              messageQueue,
              parentQueue,
              concurrencyLimitKey: this.keys.concurrencyLimitKeyFromQueue(messageQueue),
              currentConcurrencyKey: this.keys.currentConcurrencyKeyFromQueue(messageQueue),
              envConcurrencyLimitKey: this.keys.envConcurrencyLimitKeyFromQueue(messageQueue),
              envCurrentConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(messageQueue),
              orgConcurrencyLimitKey: this.keys.orgConcurrencyLimitKeyFromQueue(messageQueue),
              orgCurrentConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(messageQueue),
            });

            if (!messageData) {
              continue; // Try next queue if no message was dequeued
            }

            const message = await this.readMessage(messageData.messageId);

            if (message) {
              const ageOfMessageInMs = Date.now() - message.timestamp;

              span.setAttributes({
                [SEMATTRS_MESSAGE_ID]: message.messageId,
                [SemanticAttributes.QUEUE]: message.queue,
                [SemanticAttributes.MESSAGE_ID]: message.messageId,
                [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
                [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
                age_in_seconds: ageOfMessageInMs / 1000,
                attempted_queues: queues.indexOf(messageQueue) + 1, // How many queues we tried before success
              });

              await this.options.subscriber?.messageDequeued(message);

              await this.options.visibilityTimeoutStrategy.heartbeat(
                messageData.messageId,
                this.visibilityTimeoutInMs
              );

              return message;
            }
          } catch (error) {
            // Log error but continue trying other queues
            logger.warn(`[${this.name}] Failed to dequeue from queue ${messageQueue}`, { error });
            continue;
          }
        }

        // If we get here, we tried all queues but couldn't dequeue a message
        span.setAttribute("attempted_queues", queues.length);
        return;
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

  public async acknowledgeMessage(messageId: string, reason: string = "unknown") {
    return this.#trace(
      "acknowledgeMessage",
      async (span) => {
        const message = await this.readMessage(messageId);

        if (!message) {
          logger.log(`[${this.name}].acknowledgeMessage() message not found`, {
            messageId,
            service: this.name,
            reason,
          });
          return;
        }

        span.setAttributes({
          [SemanticAttributes.QUEUE]: message.queue,
          [SemanticAttributes.MESSAGE_ID]: message.messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
          [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
          ["marqs.reason"]: reason,
        });

        await this.options.visibilityTimeoutStrategy.cancelHeartbeat(messageId);

        await this.#callAcknowledgeMessage({
          parentQueue: message.parentQueue,
          messageKey: this.keys.messageKey(messageId),
          messageQueue: message.queue,
          concurrencyKey: this.keys.currentConcurrencyKeyFromQueue(message.queue),
          envConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(message.queue),
          orgConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(message.queue),
          messageId,
        });

        await this.options.subscriber?.messageAcked(message);
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
          data: { ...oldMessage.data, ...messageData, ...traceContext },
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
          concurrencyKey: this.keys.currentConcurrencyKeyFromQueue(oldMessage.queue),
          envConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(oldMessage.queue),
          orgConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(oldMessage.queue),
          messageId,
        });

        await this.#callEnqueueMessage(newMessage);

        await this.options.subscriber?.messageReplaced(newMessage);
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

  public async cancelHeartbeat(messageId: string) {
    return this.#trace(
      "cancelHeartbeat",
      async (span) => {
        span.setAttributes({
          [SemanticAttributes.MESSAGE_ID]: messageId,
        });

        await this.options.visibilityTimeoutStrategy.cancelHeartbeat(messageId);
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "cancelHeartbeat",
          [SEMATTRS_MESSAGE_ID]: messageId,
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
        },
      }
    );
  }

  public async releaseConcurrency(messageId: string, releaseForRun: boolean = false) {
    return this.#trace(
      "releaseConcurrency",
      async (span) => {
        span.setAttributes({
          [SemanticAttributes.MESSAGE_ID]: messageId,
        });

        const message = await this.readMessage(messageId);

        if (!message) {
          logger.log(`[${this.name}].releaseConcurrency() message not found`, {
            messageId,
            releaseForRun,
            service: this.name,
          });
          return;
        }

        span.setAttributes({
          [SemanticAttributes.QUEUE]: message.queue,
          [SemanticAttributes.MESSAGE_ID]: message.messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
          [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
        });

        const concurrencyKey = this.keys.currentConcurrencyKeyFromQueue(message.queue);
        const envConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
        const orgConcurrencyKey = this.keys.orgCurrentConcurrencyKeyFromQueue(message.queue);

        logger.debug("Calling releaseConcurrency", {
          messageId,
          queue: message.queue,
          concurrencyKey,
          envConcurrencyKey,
          orgConcurrencyKey,
          service: this.name,
          releaseForRun,
        });

        return this.redis.releaseConcurrency(
          //don't release the for the run, it breaks concurrencyLimits
          releaseForRun ? concurrencyKey : "",
          envConcurrencyKey,
          orgConcurrencyKey,
          message.messageId
        );
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "releaseConcurrency",
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

          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: e instanceof Error ? e.message : "Unknown error",
          });

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
          logger.debug(`[${this.name}].nackMessage() message not found`, {
            messageId,
            retryAt,
            updates,
            service: this.name,
          });
          return;
        }

        const nackCount = await this.#getNackCount(messageId);

        span.setAttribute("nack_count", nackCount);

        if (nackCount >= this.options.maximumNackCount) {
          logger.debug(`[${this.name}].nackMessage() maximum nack count reached`, {
            messageId,
            retryAt,
            updates,
            service: this.name,
          });

          span.setAttribute("maximum_nack_count_reached", true);

          // If we have reached the maximum nack count, we will ack the message
          await this.acknowledgeMessage(messageId, "maximum nack count reached");
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
          nackCounterKey: this.keys.nackCounterKey(messageId),
          messageId,
          messageScore: retryAt,
        });

        await this.options.subscriber?.messageNacked(message);
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

  async #getNackCount(messageId: string): Promise<number> {
    const result = await this.redis.get(this.keys.nackCounterKey(messageId));

    return result ? Number(result) : 0;
  }

  // This should increment by the number of seconds, but with a max value of Date.now() + visibilityTimeoutInMs
  public async heartbeatMessage(messageId: string) {
    await this.options.visibilityTimeoutStrategy.heartbeat(messageId, this.visibilityTimeoutInMs);
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
    const concurrencyKey = this.keys.currentConcurrencyKeyFromQueue(message.queue);
    const envConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
    const orgConcurrencyKey = this.keys.orgCurrentConcurrencyKeyFromQueue(message.queue);

    logger.debug("Calling enqueueMessage", {
      messagePayload: message,
      concurrencyKey,
      envConcurrencyKey,
      orgConcurrencyKey,
      service: this.name,
    });

    return this.redis.enqueueMessage(
      message.queue,
      message.parentQueue,
      this.keys.messageKey(message.messageId),
      concurrencyKey,
      envConcurrencyKey,
      orgConcurrencyKey,
      this.keys.envQueueKeyFromQueue(message.queue),
      message.queue,
      message.messageId,
      JSON.stringify(message),
      String(message.timestamp)
    );
  }

  async #callDequeueMessage({
    messageQueue,
    parentQueue,
    concurrencyLimitKey,
    envConcurrencyLimitKey,
    orgConcurrencyLimitKey,
    currentConcurrencyKey,
    envCurrentConcurrencyKey,
    orgCurrentConcurrencyKey,
  }: {
    messageQueue: string;
    parentQueue: string;
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
      this.keys.envQueueKeyFromQueue(messageQueue),
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
    concurrencyKey,
    envConcurrencyKey,
    orgConcurrencyKey,
    messageId,
  }: {
    parentQueue: string;
    messageKey: string;
    messageQueue: string;
    concurrencyKey: string;
    envConcurrencyKey: string;
    orgConcurrencyKey: string;
    messageId: string;
  }) {
    logger.debug("Calling acknowledgeMessage", {
      messageKey,
      messageQueue,
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
      concurrencyKey,
      envConcurrencyKey,
      orgConcurrencyKey,
      this.keys.envQueueKeyFromQueue(messageQueue),
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
    nackCounterKey,
    messageId,
    messageScore,
  }: {
    messageKey: string;
    messageQueue: string;
    parentQueue: string;
    concurrencyKey: string;
    envConcurrencyKey: string;
    orgConcurrencyKey: string;
    nackCounterKey: string;
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
      nackCounterKey,
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
      this.keys.envQueueKeyFromQueue(messageQueue),
      nackCounterKey,
      messageQueue,
      messageId,
      String(Date.now()),
      String(messageScore)
    );
  }

  async #callCalculateQueueCurrentConcurrencies({
    currentConcurrencyKey,
    currentEnvConcurrencyKey,
    currentOrgConcurrencyKey,
  }: {
    currentConcurrencyKey: string;
    currentEnvConcurrencyKey: string;
    currentOrgConcurrencyKey: string;
  }) {
    const currentConcurrencies = await this.redis.calculateQueueCurrentConcurrencies(
      currentConcurrencyKey,
      currentEnvConcurrencyKey,
      currentOrgConcurrencyKey
    );

    const orgCurrent = Number(currentConcurrencies[0]);
    const envCurrent = Number(currentConcurrencies[1]);
    const queueCurrent = Number(currentConcurrencies[2]);

    return {
      queue: queueCurrent,
      env: envCurrent,
      org: orgCurrent,
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
      numberOfKeys: 7,
      lua: `
local queue = KEYS[1]
local parentQueue = KEYS[2]
local messageKey = KEYS[3]
local concurrencyKey = KEYS[4]
local envCurrentConcurrencyKey = KEYS[5]
local orgCurrentConcurrencyKey = KEYS[6]
local envQueue = KEYS[7]

local queueName = ARGV[1]
local messageId = ARGV[2]
local messageData = ARGV[3]
local messageScore = ARGV[4]

-- Write the message to the message key
redis.call('SET', messageKey, messageData)

-- Add the message to the queue
redis.call('ZADD', queue, messageScore, messageId)

-- Add the message to the env queue
redis.call('ZADD', envQueue, messageScore, messageId)

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
redis.call('SREM', orgCurrentConcurrencyKey, messageId)
      `,
    });

    this.redis.defineCommand("dequeueMessage", {
      numberOfKeys: 9,
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
local envQueueKey = KEYS[9]

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
redis.call('ZREM', envQueueKey, messageId)
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
-- Keys: parentQueue, messageKey, messageQueue, concurrencyKey, envCurrentConcurrencyKey, orgCurrentConcurrencyKey
local parentQueue = KEYS[1]
local messageKey = KEYS[2]
local messageQueue = KEYS[3]
local concurrencyKey = KEYS[4]
local envCurrentConcurrencyKey = KEYS[5]
local orgCurrentConcurrencyKey = KEYS[6]
local envQueueKey = KEYS[7]

-- Args: messageId, messageQueueName
local messageId = ARGV[1]
local messageQueueName = ARGV[2]

-- Remove the message from the message key
redis.call('DEL', messageKey)

-- Remove the message from the queue
redis.call('ZREM', messageQueue, messageId)

-- Remove the message from the env queue
redis.call('ZREM', envQueueKey, messageId)

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', messageQueue, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueue, messageQueueName)
else
    redis.call('ZADD', parentQueue, earliestMessage[2], messageQueueName)
end

-- Update the concurrency keys
redis.call('SREM', concurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
redis.call('SREM', orgCurrentConcurrencyKey, messageId)
`,
    });

    this.redis.defineCommand("nackMessage", {
      numberOfKeys: 8,
      lua: `
local messageKey = KEYS[1]
local childQueueKey = KEYS[2]
local parentQueueKey = KEYS[3]
local concurrencyKey = KEYS[4]
local envConcurrencyKey = KEYS[5]
local orgConcurrencyKey = KEYS[6]
local envQueueKey = KEYS[7]
local nackCounterKey = KEYS[8]

-- Args: childQueueName, messageId, currentTime, messageScore
local childQueueName = ARGV[1]
local messageId = ARGV[2]
local currentTime = tonumber(ARGV[3])
local messageScore = tonumber(ARGV[4])

-- Update the concurrency keys
redis.call('SREM', concurrencyKey, messageId)
redis.call('SREM', envConcurrencyKey, messageId)
redis.call('SREM', orgConcurrencyKey, messageId)

-- Enqueue the message into the queue
redis.call('ZADD', childQueueKey, messageScore, messageId)

-- Enqueue the message into the env queue
redis.call('ZADD', envQueueKey, messageScore, messageId)

-- Increment the nack counter with an expiry of 30 days
redis.call('INCR', nackCounterKey)
redis.call('EXPIRE', nackCounterKey, 2592000)

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

    this.redis.defineCommand("calculateQueueCurrentConcurrencies", {
      numberOfKeys: 3,
      lua: `
-- Keys: currentConcurrencyKey, currentEnvConcurrencyKey, currentOrgConcurrencyKey
local currentConcurrencyKey = KEYS[1]
local currentEnvConcurrencyKey = KEYS[2]
local currentOrgConcurrencyKey = KEYS[3]

local currentOrgConcurrency = tonumber(redis.call('SCARD', currentOrgConcurrencyKey) or '0')

local currentEnvConcurrency = tonumber(redis.call('SCARD', currentEnvConcurrencyKey) or '0')

local currentConcurrency = tonumber(redis.call('SCARD', currentConcurrencyKey) or '0')

return { currentOrgConcurrency, currentEnvConcurrency, currentConcurrency } 
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
      concurrencyKey: string,
      envConcurrencyKey: string,
      orgConcurrencyKey: string,
      envQueue: string,
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
      envQueueKey: string,
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
      concurrencyKey: string,
      envConcurrencyKey: string,
      orgConcurrencyKey: string,
      envQueueKey: string,
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
      envQueueKey: string,
      nackCounterKey: string,
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

    calculateQueueCurrentConcurrencies(
      currentConcurrencyKey: string,
      currentEnvConcurrencyKey: string,
      currentOrgConcurrencyKey: string,
      callback?: Callback<number[]>
    ): Result<number[], Context>;
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

      const redis = new Redis(redisOptions);
      const keysProducer = new MarQSShortKeyProducer(KEY_PREFIX);

      return new MarQS({
        name: "marqs",
        tracer: trace.getTracer("marqs"),
        keysProducer,
        visibilityTimeoutStrategy: new V3VisibilityTimeout(),
        queuePriorityStrategy: new FairDequeuingStrategy({
          tracer: tracer,
          redis,
          parentQueueLimit: env.MARQS_SHARED_QUEUE_LIMIT,
          keys: keysProducer,
          defaultEnvConcurrency: env.DEFAULT_ENV_EXECUTION_CONCURRENCY_LIMIT,
          defaultOrgConcurrency: env.DEFAULT_ORG_EXECUTION_CONCURRENCY_LIMIT,
          checkForDisabledOrgs: true,
        }),
        envQueuePriorityStrategy: new FairDequeuingStrategy({
          tracer: tracer,
          redis,
          parentQueueLimit: env.MARQS_DEV_QUEUE_LIMIT,
          keys: keysProducer,
          defaultEnvConcurrency: env.DEFAULT_ENV_EXECUTION_CONCURRENCY_LIMIT,
          defaultOrgConcurrency: env.DEFAULT_ORG_EXECUTION_CONCURRENCY_LIMIT,
          checkForDisabledOrgs: false,
        }),
        workers: 1,
        redis,
        defaultEnvConcurrency: env.DEFAULT_ENV_EXECUTION_CONCURRENCY_LIMIT,
        defaultOrgConcurrency: env.DEFAULT_ORG_EXECUTION_CONCURRENCY_LIMIT,
        visibilityTimeoutInMs: env.MARQS_VISIBILITY_TIMEOUT_MS,
        enableRebalancing: !env.MARQS_DISABLE_REBALANCING,
        maximumNackCount: env.MARQS_MAXIMUM_NACK_COUNT,
        subscriber: concurrencyTracker,
      });
    } else {
      console.warn(
        "Could not initialize MarQS because process.env.REDIS_HOST and process.env.REDIS_PORT are required to be set. Trigger.dev v3 will not work without this."
      );
    }
  }
}
