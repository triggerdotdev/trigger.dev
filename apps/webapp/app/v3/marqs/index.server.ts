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
  SEMATTRS_MESSAGING_SYSTEM,
  SEMATTRS_MESSAGING_OPERATION,
} from "@opentelemetry/semantic-conventions";
import { flattenAttributes } from "@trigger.dev/core/v3";
import Redis, { type Callback, type Result } from "ioredis";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { concurrencyTracker } from "../services/taskRunConcurrencyTracker.server";
import { attributesFromAuthenticatedEnv, tracer } from "../tracer.server";
import { AsyncWorker } from "./asyncWorker.server";
import { FairDequeuingStrategy } from "./fairDequeuingStrategy.server";
import { MarQSShortKeyProducer } from "./marqsKeyProducer";
import {
  EnqueueMessageReserveConcurrencyOptions,
  MarQSFairDequeueStrategy,
  MarQSKeyProducer,
  MarQSKeyProducerEnv,
  MarQSPriorityLevel,
  MessagePayload,
  MessageQueueSubscriber,
  VisibilityTimeoutStrategy,
} from "./types";
import { V3LegacyRunEngineWorkerVisibilityTimeout } from "./v3VisibilityTimeout.server";
import { legacyRunEngineWorker } from "../legacyRunEngineWorker.server";
import {
  MARQS_DELAYED_REQUEUE_THRESHOLD_IN_MS,
  MARQS_RESUME_PRIORITY_TIMESTAMP_OFFSET,
  MARQS_RETRY_PRIORITY_TIMESTAMP_OFFSET,
  MARQS_SCHEDULED_REQUEUE_AVAILABLE_AT_THRESHOLD_IN_MS,
} from "./constants.server";

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
    const envConcurrencyLimitKey = this.keys.envConcurrencyLimitKey(env);

    logger.debug("Updating env concurrency limits", {
      envConcurrencyLimitKey,
      service: this.name,
    });

    await this.#callUpdateGlobalConcurrencyLimits({
      envConcurrencyLimitKey,
      envConcurrencyLimit: env.maximumConcurrencyLimit,
    });
  }

  public async getQueueConcurrencyLimit(env: MarQSKeyProducerEnv, queue: string) {
    const result = await this.redis.get(this.keys.queueConcurrencyLimitKey(env, queue));

    return result ? Number(result) : undefined;
  }

  public async getEnvConcurrencyLimit(env: MarQSKeyProducerEnv) {
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

  public async lengthOfEnvQueue(env: MarQSKeyProducerEnv) {
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
    env: MarQSKeyProducerEnv,
    queue: string,
    concurrencyKey?: string
  ) {
    return this.redis.scard(this.keys.queueCurrentConcurrencyKey(env, queue, concurrencyKey));
  }

  public async reserveConcurrencyOfQueue(
    env: MarQSKeyProducerEnv,
    queue: string,
    concurrencyKey?: string
  ) {
    return this.redis.scard(
      this.keys.queueReserveConcurrencyKeyFromQueue(this.keys.queueKey(env, queue, concurrencyKey))
    );
  }

  public async currentConcurrencyOfEnvironment(env: MarQSKeyProducerEnv) {
    return this.redis.scard(this.keys.envCurrentConcurrencyKey(env));
  }

  public async reserveConcurrencyOfEnvironment(env: MarQSKeyProducerEnv) {
    return this.redis.scard(this.keys.envReserveConcurrencyKey(env.id));
  }

  public async removeEnvironmentQueuesFromMasterQueue(orgId: string, environmentId: string) {
    const sharedQueue = this.keys.sharedQueueKey();
    const queuePattern = this.keys.queueKey(orgId, environmentId, "*");

    // Use scanStream to find all matching members
    const stream = this.redis.zscanStream(sharedQueue, {
      match: queuePattern,
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
          await this.redis.zrem(sharedQueue, matchingQueues);
        }
        resolve();
      });

      stream.on("error", (err) => reject(err));
    });
  }

  public async enqueueMessage(
    env: AuthenticatedEnvironment,
    queue: string,
    messageId: string,
    messageData: Record<string, unknown>,
    concurrencyKey?: string,
    timestamp?: number | Date,
    reserve?: EnqueueMessageReserveConcurrencyOptions,
    priority?: MarQSPriorityLevel
  ) {
    return await this.#trace(
      "enqueueMessage",
      async (span) => {
        const messageQueue = this.keys.queueKey(env, queue, concurrencyKey);

        const parentQueue = this.keys.envSharedQueueKey(env);

        propagation.inject(context.active(), messageData);

        const $timestamp =
          typeof timestamp === "undefined"
            ? Date.now()
            : typeof timestamp === "number"
            ? timestamp
            : timestamp.getTime();

        const messagePayload: MessagePayload = {
          version: "1",
          data: messageData,
          queue: messageQueue,
          concurrencyKey,
          timestamp: $timestamp,
          messageId,
          parentQueue,
          priority,
          availableAt: Date.now(),
          enqueueMethod: "enqueue",
        };

        span.setAttributes({
          [SemanticAttributes.QUEUE]: queue,
          [SemanticAttributes.MESSAGE_ID]: messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: concurrencyKey,
          [SemanticAttributes.PARENT_QUEUE]: parentQueue,
        });

        if (reserve) {
          span.setAttribute("reserve_message_id", reserve.messageId);
          span.setAttribute("reserve_recursive_queue", reserve.recursiveQueue);
        }

        const result = await this.#callEnqueueMessage(messagePayload, reserve);

        if (result) {
          await this.options.subscriber?.messageEnqueued(messagePayload);
        }

        return result;
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

  public async replaceMessage(
    messageId: string,
    messageData: Record<string, unknown>,
    timestamp?: number
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
          data: { ...oldMessage.data, ...messageData, ...traceContext, queue: oldMessage.queue },
          queue: oldMessage.queue,
          concurrencyKey: oldMessage.concurrencyKey,
          timestamp: timestamp ?? Date.now(),
          messageId,
          parentQueue: oldMessage.parentQueue,
          priority: oldMessage.priority,
          enqueueMethod: "replace",
        };

        await this.#saveMessageIfExists(newMessage);
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

  public async requeueMessage(
    messageId: string,
    messageData: Record<string, unknown>,
    timestamp?: number,
    priority?: MarQSPriorityLevel
  ) {
    return this.#trace(
      "requeueMessage",
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

        const $timestamp = timestamp ?? Date.now();

        const newMessage: MessagePayload = {
          version: "1",
          // preserve original trace context
          data: {
            ...oldMessage.data,
            ...messageData,
            ...traceContext,
            queue: oldMessage.queue,
          },
          queue: oldMessage.queue,
          concurrencyKey: oldMessage.concurrencyKey,
          timestamp: $timestamp,
          messageId,
          parentQueue: oldMessage.parentQueue,
          priority: priority ?? oldMessage.priority,
          availableAt: $timestamp,
          enqueueMethod: "requeue",
        };

        await this.options.visibilityTimeoutStrategy.cancelHeartbeat(messageId);

        // If the message timestamp is enough in the future (e.g. more than 500ms from now),
        // we will schedule it to be requeued in the future using the legacy run engine redis worker
        // If not, we just requeue it immediately
        if ($timestamp > Date.now() + MARQS_DELAYED_REQUEUE_THRESHOLD_IN_MS) {
          await this.#callDelayedRequeueMessage(newMessage);
        } else {
          await this.#callRequeueMessage(newMessage);
        }
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "requeue",
          [SEMATTRS_MESSAGE_ID]: messageId,
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
        },
      }
    );
  }

  public async requeueMessageById(messageId: string) {
    return this.#trace(
      "requeueMessageById",
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

        logger.debug(`Requeueing message by id`, { messageId, message, service: this.name });

        await this.#callRequeueMessage(message);
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "requeue_by_id",
          [SEMATTRS_MESSAGE_ID]: messageId,
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
        },
      }
    );
  }

  async #saveMessage(message: MessagePayload) {
    logger.debug(`Saving message`, { message, service: this.name });

    const messageKey = this.keys.messageKey(message.messageId);

    await this.redis.set(messageKey, JSON.stringify(message));
  }

  async #saveMessageIfExists(message: MessagePayload) {
    logger.debug(`Saving message if exists`, { message, service: this.name });

    const messageKey = this.keys.messageKey(message.messageId);

    await this.redis.set(messageKey, JSON.stringify(message), "XX"); // XX means only set if key exists
  }

  public async dequeueMessageInEnv(env: AuthenticatedEnvironment) {
    return this.#trace(
      "dequeueMessageInEnv",
      async (span) => {
        const parentQueue = this.keys.envSharedQueueKey(env);

        span.setAttribute(SemanticAttributes.PARENT_QUEUE, parentQueue);
        span.setAttribute(SemanticAttributes.CONSUMER_ID, env.id);

        // Get prioritized list of queues to try
        const environments =
          await this.options.envQueuePriorityStrategy.distributeFairQueuesFromParentQueue(
            parentQueue,
            env.id
          );

        const queues = environments.flatMap((e) => e.queues);

        span.setAttribute("env_count", environments.length);
        span.setAttribute("queue_count", queues.length);

        for (const messageQueue of queues) {
          const messageData = await this.#callDequeueMessage({
            messageQueue,
            parentQueue,
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
              message_age: this.#calculateMessageAge(message),
              message_priority: message.priority,
              message_enqueue_method: message.enqueueMethod,
              message_available_at: message.availableAt,
              ...flattenAttributes(message.data, "message.data"),
            });

            await this.options.subscriber?.messageDequeued(message);
          } else {
            logger.error(`Failed to read message, undoing the dequeueing of the message`, {
              messageData,
              service: this.name,
            });

            await this.#callAcknowledgeMessage({
              parentQueue,
              messageQueue: messageQueue,
              messageId: messageData.messageId,
            });

            return;
          }

          await this.options.visibilityTimeoutStrategy.startHeartbeat(
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
        const envQueues =
          await this.options.queuePriorityStrategy.distributeFairQueuesFromParentQueue(
            parentQueue,
            consumerId
          );

        span.setAttribute("environment_count", envQueues.length);

        if (envQueues.length === 0) {
          return;
        }

        let attemptedEnvs = 0;
        let attemptedQueues = 0;

        // Try each queue in order until we successfully dequeue a message
        for (const env of envQueues) {
          attemptedEnvs++;

          for (const messageQueue of env.queues) {
            attemptedQueues++;

            const result = await this.#trace(
              "attemptDequeue",
              async (innerSpan) => {
                try {
                  innerSpan.setAttributes({
                    [SemanticAttributes.QUEUE]: messageQueue,
                    [SemanticAttributes.PARENT_QUEUE]: parentQueue,
                  });

                  const messageData = await this.#trace(
                    "callDequeueMessage",
                    async (dequeueSpan) => {
                      dequeueSpan.setAttributes({
                        [SemanticAttributes.QUEUE]: messageQueue,
                        [SemanticAttributes.PARENT_QUEUE]: parentQueue,
                      });

                      return await this.#callDequeueMessage({
                        messageQueue,
                        parentQueue,
                      });
                    },
                    {
                      kind: SpanKind.CONSUMER,
                      attributes: {
                        [SEMATTRS_MESSAGING_OPERATION]: "dequeue",
                        [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
                      },
                    }
                  );

                  if (!messageData) {
                    return null; // Try next queue if no message was dequeued
                  }

                  const message = await this.readMessage(messageData.messageId);

                  if (message) {
                    const attributes = {
                      [SEMATTRS_MESSAGE_ID]: message.messageId,
                      [SemanticAttributes.QUEUE]: message.queue,
                      [SemanticAttributes.MESSAGE_ID]: message.messageId,
                      [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
                      [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
                      attempted_queues: attemptedQueues, // How many queues we tried before success
                      attempted_envs: attemptedEnvs, // How many environments we tried before success
                      message_timestamp: message.timestamp,
                      message_age: this.#calculateMessageAge(message),
                      message_priority: message.priority,
                      message_enqueue_method: message.enqueueMethod,
                      message_available_at: message.availableAt,
                      ...flattenAttributes(message.data, "message.data"),
                    };

                    span.setAttributes(attributes);
                    innerSpan.setAttributes(attributes);

                    await this.#trace(
                      "messageDequeued",
                      async (subscriberSpan) => {
                        subscriberSpan.setAttributes({
                          [SemanticAttributes.MESSAGE_ID]: message.messageId,
                          [SemanticAttributes.QUEUE]: message.queue,
                          [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
                        });

                        return await this.options.subscriber?.messageDequeued(message);
                      },
                      {
                        kind: SpanKind.INTERNAL,
                        attributes: {
                          [SEMATTRS_MESSAGING_OPERATION]: "notify",
                          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
                        },
                      }
                    );

                    await this.#trace(
                      "startHeartbeat",
                      async (heartbeatSpan) => {
                        heartbeatSpan.setAttributes({
                          [SemanticAttributes.MESSAGE_ID]: messageData.messageId,
                          visibility_timeout_ms: this.visibilityTimeoutInMs,
                        });

                        return await this.options.visibilityTimeoutStrategy.startHeartbeat(
                          messageData.messageId,
                          this.visibilityTimeoutInMs
                        );
                      },
                      {
                        kind: SpanKind.INTERNAL,
                        attributes: {
                          [SEMATTRS_MESSAGING_OPERATION]: "heartbeat",
                          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
                        },
                      }
                    );

                    return message;
                  }
                } catch (error) {
                  // Log error but continue trying other queues
                  logger.warn(`[${this.name}] Failed to dequeue from queue ${messageQueue}`, {
                    error,
                  });
                  return null;
                }
              },
              {
                kind: SpanKind.CONSUMER,
                attributes: {
                  [SEMATTRS_MESSAGING_OPERATION]: "dequeue",
                  [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
                },
              }
            );

            if (result) {
              return result;
            }
          }
        }

        // If we get here, we tried all queues but couldn't dequeue a message
        span.setAttribute("attempted_queues", attemptedQueues);
        span.setAttribute("attempted_envs", attemptedEnvs);

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
          messageQueue: message.queue,
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

  /**
   * Negative acknowledge a message, which will requeue the message.
   * Returns whether it went back into the queue or not.
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
          return false;
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
          return false;
        }

        span.setAttributes({
          [SemanticAttributes.QUEUE]: message.queue,
          [SemanticAttributes.MESSAGE_ID]: message.messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
          [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
        });

        if (updates) {
          await this.replaceMessage(messageId, updates, retryAt);
        }

        await this.options.visibilityTimeoutStrategy.cancelHeartbeat(messageId);

        await this.#callNackMessage(messageId, message, retryAt);

        await this.options.subscriber?.messageNacked(message);

        return true;
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

  #nudgeTimestampForPriority(timestamp: number, priority?: MarQSPriorityLevel) {
    if (!priority) {
      return timestamp;
    }

    switch (priority) {
      case "resume": {
        return timestamp - MARQS_RESUME_PRIORITY_TIMESTAMP_OFFSET;
      }
      case "retry": {
        return timestamp - MARQS_RETRY_PRIORITY_TIMESTAMP_OFFSET;
      }
    }
  }

  #calculateMessageAge(message: MessagePayload) {
    const $timestamp = message.availableAt ?? message.timestamp;

    return Date.now() - $timestamp;
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

  async #callEnqueueMessage(
    message: MessagePayload,
    reserve?: EnqueueMessageReserveConcurrencyOptions
  ) {
    const queueKey = message.queue;
    const parentQueueKey = message.parentQueue;
    const messageKey = this.keys.messageKey(message.messageId);
    const queueCurrentConcurrencyKey = this.keys.queueCurrentConcurrencyKeyFromQueue(message.queue);
    const queueReserveConcurrencyKey = this.keys.queueReserveConcurrencyKeyFromQueue(message.queue);
    const envCurrentConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
    const envReserveConcurrencyKey = this.keys.envReserveConcurrencyKeyFromQueue(message.queue);
    const envQueueKey = this.keys.envQueueKeyFromQueue(message.queue);

    const queueName = message.queue;
    const messageId = message.messageId;
    const messageData = JSON.stringify(message);
    const messageScore = String(
      this.#nudgeTimestampForPriority(message.timestamp, message.priority)
    );

    if (!reserve) {
      logger.debug("Calling enqueueMessage", {
        service: this.name,
        queueKey,
        parentQueueKey,
        messageKey,
        queueCurrentConcurrencyKey,
        queueReserveConcurrencyKey,
        envCurrentConcurrencyKey,
        envReserveConcurrencyKey,
        envQueueKey,
        queueName,
        messageId,
        messageData,
        messageScore,
      });

      const result = await this.redis.enqueueMessage(
        queueKey,
        parentQueueKey,
        messageKey,
        queueCurrentConcurrencyKey,
        queueReserveConcurrencyKey,
        envCurrentConcurrencyKey,
        envReserveConcurrencyKey,
        envQueueKey,
        queueName,
        messageId,
        messageData,
        messageScore
      );

      logger.debug("enqueueMessage result", {
        service: this.name,
        queueKey,
        parentQueueKey,
        messageKey,
        queueCurrentConcurrencyKey,
        queueReserveConcurrencyKey,
        envCurrentConcurrencyKey,
        envReserveConcurrencyKey,
        envQueueKey,
        queueName,
        messageId,
        messageData,
        messageScore,
        result,
      });

      return true;
    }

    const envConcurrencyLimitKey = this.keys.envConcurrencyLimitKeyFromQueue(message.queue);
    const reserveMessageId = reserve.messageId;
    const defaultEnvConcurrencyLimit = String(this.options.defaultEnvConcurrency);

    if (!reserve.recursiveQueue) {
      logger.debug("Calling enqueueMessageWithReservingConcurrency", {
        service: this.name,
        queueKey,
        parentQueueKey,
        messageKey,
        queueCurrentConcurrencyKey,
        queueReserveConcurrencyKey,
        envCurrentConcurrencyKey,
        envReserveConcurrencyKey,
        envConcurrencyLimitKey,
        envQueueKey,
        queueName,
        messageId,
        messageData,
        messageScore,
        reserveMessageId,
        defaultEnvConcurrencyLimit,
      });

      const result = await this.redis.enqueueMessageWithReservingConcurrency(
        queueKey,
        parentQueueKey,
        messageKey,
        queueCurrentConcurrencyKey,
        queueReserveConcurrencyKey,
        envCurrentConcurrencyKey,
        envReserveConcurrencyKey,
        envConcurrencyLimitKey,
        envQueueKey,
        queueName,
        messageId,
        messageData,
        messageScore,
        reserveMessageId,
        defaultEnvConcurrencyLimit
      );

      logger.debug("enqueueMessageWithReservingConcurrency result", {
        service: this.name,
        queueKey,
        parentQueueKey,
        messageKey,
        queueCurrentConcurrencyKey,
        queueReserveConcurrencyKey,
        envCurrentConcurrencyKey,
        envReserveConcurrencyKey,
        envConcurrencyLimitKey,
        envQueueKey,
        queueName,
        messageId,
        messageData,
        messageScore,
        reserveMessageId,
        defaultEnvConcurrencyLimit,
        result,
      });

      return true;
    } else {
      const queueConcurrencyLimitKey = this.keys.queueConcurrencyLimitKeyFromQueue(message.queue);

      logger.debug("Calling enqueueMessageWithReservingConcurrencyForRecursiveQueue", {
        service: this.name,
        queueKey,
        parentQueueKey,
        messageKey,
        queueCurrentConcurrencyKey,
        queueReserveConcurrencyKey,
        queueConcurrencyLimitKey,
        envCurrentConcurrencyKey,
        envReserveConcurrencyKey,
        envConcurrencyLimitKey,
        envQueueKey,
        queueName,
        messageId,
        messageData,
        messageScore,
        reserveMessageId,
        defaultEnvConcurrencyLimit,
      });

      const result = await this.redis.enqueueMessageWithReservingConcurrencyOnRecursiveQueue(
        queueKey,
        parentQueueKey,
        messageKey,
        queueCurrentConcurrencyKey,
        queueReserveConcurrencyKey,
        queueConcurrencyLimitKey,
        envCurrentConcurrencyKey,
        envReserveConcurrencyKey,
        envConcurrencyLimitKey,
        envQueueKey,
        queueName,
        messageId,
        messageData,
        messageScore,
        reserveMessageId,
        defaultEnvConcurrencyLimit
      );

      logger.debug("enqueueMessageWithReservingConcurrencyOnRecursiveQueue result", {
        service: this.name,
        queueKey,
        parentQueueKey,
        messageKey,
        queueCurrentConcurrencyKey,
        queueReserveConcurrencyKey,
        queueConcurrencyLimitKey,
        envCurrentConcurrencyKey,
        envReserveConcurrencyKey,
        envConcurrencyLimitKey,
        envQueueKey,
        queueName,
        messageId,
        messageData,
        messageScore,
        reserveMessageId,
        defaultEnvConcurrencyLimit,
        result,
      });

      return !!result;
    }
  }

  async #callDequeueMessage({
    messageQueue,
    parentQueue,
  }: {
    messageQueue: string;
    parentQueue: string;
  }) {
    const queueConcurrencyLimitKey = this.keys.queueConcurrencyLimitKeyFromQueue(messageQueue);
    const queueCurrentConcurrencyKey = this.keys.queueCurrentConcurrencyKeyFromQueue(messageQueue);
    const envConcurrencyLimitKey = this.keys.envConcurrencyLimitKeyFromQueue(messageQueue);
    const envCurrentConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(messageQueue);
    const envReserveConcurrencyKey = this.keys.envReserveConcurrencyKeyFromQueue(messageQueue);
    const queueReserveConcurrencyKey = this.keys.queueReserveConcurrencyKeyFromQueue(messageQueue);
    const envQueueKey = this.keys.envQueueKeyFromQueue(messageQueue);

    logger.debug("Calling dequeueMessage", {
      messageQueue,
      parentQueue,
      queueConcurrencyLimitKey,
      envConcurrencyLimitKey,
      queueCurrentConcurrencyKey,
      queueReserveConcurrencyKey,
      envCurrentConcurrencyKey,
      envReserveConcurrencyKey,
      envQueueKey,
      service: this.name,
    });

    const result = await this.redis.dequeueMessage(
      messageQueue,
      parentQueue,
      queueConcurrencyLimitKey,
      envConcurrencyLimitKey,
      queueCurrentConcurrencyKey,
      queueReserveConcurrencyKey,
      envCurrentConcurrencyKey,
      envReserveConcurrencyKey,
      envQueueKey,
      messageQueue,
      String(Date.now()),
      String(this.options.defaultEnvConcurrency)
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

  async #callRequeueMessage(message: MessagePayload) {
    const queueKey = message.queue;
    const parentQueueKey = message.parentQueue;
    const messageKey = this.keys.messageKey(message.messageId);
    const queueCurrentConcurrencyKey = this.keys.queueCurrentConcurrencyKeyFromQueue(message.queue);
    const queueReserveConcurrencyKey = this.keys.queueReserveConcurrencyKeyFromQueue(message.queue);
    const envCurrentConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
    const envReserveConcurrencyKey = this.keys.envReserveConcurrencyKeyFromQueue(message.queue);
    const envQueueKey = this.keys.envQueueKeyFromQueue(message.queue);

    const queueName = message.queue;
    const messageId = message.messageId;
    const messageData = JSON.stringify(message);
    const messageScore = String(
      this.#nudgeTimestampForPriority(message.timestamp, message.priority)
    );

    logger.debug("Calling requeueMessage", {
      service: this.name,
      queueKey,
      parentQueueKey,
      messageKey,
      queueCurrentConcurrencyKey,
      queueReserveConcurrencyKey,
      envCurrentConcurrencyKey,
      envReserveConcurrencyKey,
      envQueueKey,
      queueName,
      messageId,
      messageData,
      messageScore,
    });

    const result = await this.redis.requeueMessage(
      queueKey,
      parentQueueKey,
      messageKey,
      queueCurrentConcurrencyKey,
      queueReserveConcurrencyKey,
      envCurrentConcurrencyKey,
      envReserveConcurrencyKey,
      envQueueKey,
      queueName,
      messageId,
      messageData,
      messageScore
    );

    logger.debug("requeueMessage result", {
      service: this.name,
      queueKey,
      parentQueueKey,
      messageKey,
      queueCurrentConcurrencyKey,
      queueReserveConcurrencyKey,
      envCurrentConcurrencyKey,
      envReserveConcurrencyKey,
      envQueueKey,
      queueName,
      messageId,
      messageData,
      messageScore,
      result,
    });

    await this.options.subscriber?.messageRequeued(message);

    return true;
  }

  async #callDelayedRequeueMessage(message: MessagePayload) {
    const messageKey = this.keys.messageKey(message.messageId);
    const queueCurrentConcurrencyKey = this.keys.queueCurrentConcurrencyKeyFromQueue(message.queue);
    const queueReserveConcurrencyKey = this.keys.queueReserveConcurrencyKeyFromQueue(message.queue);
    const envCurrentConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
    const envReserveConcurrencyKey = this.keys.envReserveConcurrencyKeyFromQueue(message.queue);

    const messageId = message.messageId;
    const messageData = JSON.stringify(message);

    logger.debug("Calling delayedRequeueMessage", {
      service: this.name,
      messageKey,
      queueCurrentConcurrencyKey,
      queueReserveConcurrencyKey,
      envCurrentConcurrencyKey,
      envReserveConcurrencyKey,
      messageId,
      messageData,
    });

    const result = await this.redis.delayedRequeueMessage(
      messageKey,
      queueCurrentConcurrencyKey,
      queueReserveConcurrencyKey,
      envCurrentConcurrencyKey,
      envReserveConcurrencyKey,
      messageId,
      messageData
    );

    logger.debug("delayedRequeueMessage result", {
      service: this.name,
      messageKey,
      queueCurrentConcurrencyKey,
      queueReserveConcurrencyKey,
      envCurrentConcurrencyKey,
      envReserveConcurrencyKey,
      messageId,
      messageData,
      result,
    });

    logger.debug("Enqueuing scheduleRequeueMessage in LRE worker", {
      service: this.name,
      message,
    });

    // Schedule the requeue in the future
    await legacyRunEngineWorker.enqueue({
      id: `marqs-requeue-${messageId}`,
      job: "scheduleRequeueMessage",
      payload: { messageId },
      availableAt: new Date(
        message.timestamp - MARQS_SCHEDULED_REQUEUE_AVAILABLE_AT_THRESHOLD_IN_MS
      ),
    });

    return true;
  }

  async #callAcknowledgeMessage({
    parentQueue,
    messageQueue,
    messageId,
  }: {
    parentQueue: string;
    messageQueue: string;
    messageId: string;
  }) {
    const messageKey = this.keys.messageKey(messageId);
    const concurrencyKey = this.keys.queueCurrentConcurrencyKeyFromQueue(messageQueue);
    const envConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(messageQueue);
    const envReserveConcurrencyKey = this.keys.envReserveConcurrencyKeyFromQueue(messageQueue);
    const queueReserveConcurrencyKey = this.keys.queueReserveConcurrencyKeyFromQueue(messageQueue);
    const envQueueKey = this.keys.envQueueKeyFromQueue(messageQueue);

    logger.debug("Calling acknowledgeMessage", {
      messageKey,
      messageQueue,
      concurrencyKey,
      envConcurrencyKey,
      messageId,
      parentQueue,
      envQueueKey,
      service: this.name,
    });

    return this.redis.acknowledgeMessage(
      parentQueue,
      messageKey,
      messageQueue,
      concurrencyKey,
      queueReserveConcurrencyKey,
      envConcurrencyKey,
      envReserveConcurrencyKey,
      envQueueKey,
      messageId,
      messageQueue
    );
  }

  async #callNackMessage(messageId: string, message: MessagePayload, messageScore: number) {
    const messageKey = this.keys.messageKey(message.messageId);
    const queueKey = message.queue;
    const parentQueueKey = message.parentQueue;
    const queueCurrentConcurrencyKey = this.keys.queueCurrentConcurrencyKeyFromQueue(message.queue);
    const envCurrentConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
    const nackCounterKey = this.keys.nackCounterKey(message.messageId);
    const envQueueKey = this.keys.envQueueKeyFromQueue(message.queue);
    const queueName = message.queue;

    logger.debug("Calling nackMessage", {
      messageKey,
      queueKey,
      parentQueueKey,
      queueCurrentConcurrencyKey,
      envCurrentConcurrencyKey,
      nackCounterKey,
      messageId,
      messageScore,
      envQueueKey,
      service: this.name,
    });

    return this.redis.nackMessage(
      messageKey,
      queueKey,
      parentQueueKey,
      queueCurrentConcurrencyKey,
      envCurrentConcurrencyKey,
      envQueueKey,
      nackCounterKey,
      queueName,
      messageId,
      String(Date.now()),
      String(messageScore)
    );
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
      numberOfKeys: 8,
      lua: `
local queueKey = KEYS[1]
local parentQueueKey = KEYS[2]
local messageKey = KEYS[3]
local queueCurrentConcurrencyKey = KEYS[4]
local queueReserveConcurrencyKey = KEYS[5]
local envCurrentConcurrencyKey = KEYS[6]
local envReserveConcurrencyKey = KEYS[7]
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

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueueKey, queueName)
else
    redis.call('ZADD', parentQueueKey, earliestMessage[2], queueName)
end

-- Update the concurrency keys
redis.call('SREM', queueCurrentConcurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
redis.call('SREM', envReserveConcurrencyKey, messageId)
redis.call('SREM', queueReserveConcurrencyKey, messageId)

return true
      `,
    });

    this.redis.defineCommand("enqueueMessageWithReservingConcurrency", {
      numberOfKeys: 9,
      lua: `
local queueKey = KEYS[1]
local parentQueueKey = KEYS[2]
local messageKey = KEYS[3]
local queueCurrentConcurrencyKey = KEYS[4]
local queueReserveConcurrencyKey = KEYS[5]
local envCurrentConcurrencyKey = KEYS[6]
local envReserveConcurrencyKey = KEYS[7]
local envConcurrencyLimitKey = KEYS[8]
local envQueueKey = KEYS[9]

local queueName = ARGV[1]
local messageId = ARGV[2]
local messageData = ARGV[3]
local messageScore = ARGV[4]
local reserveMessageId = ARGV[5]
local defaultEnvConcurrencyLimit = ARGV[6]

-- Write the message to the message key
redis.call('SET', messageKey, messageData)

-- Add the message to the queue
redis.call('ZADD', queueKey, messageScore, messageId)

-- Add the message to the env queue
redis.call('ZADD', envQueueKey, messageScore, messageId)

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueueKey, queueName)
else
    redis.call('ZADD', parentQueueKey, earliestMessage[2], queueName)
end

-- Update the concurrency keys
redis.call('SREM', queueCurrentConcurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
redis.call('SREM', envReserveConcurrencyKey, messageId)
redis.call('SREM', queueReserveConcurrencyKey, messageId)

-- Reserve the concurrency for the message
local envReserveConcurrencyLimit = tonumber(redis.call('GET', envConcurrencyLimitKey) or defaultEnvConcurrencyLimit)
-- Count the number of messages in the reserve concurrency set
local envReserveConcurrency = tonumber(redis.call('SCARD', envReserveConcurrencyKey) or '0')

-- If there is space, add the messaageId to the env reserve concurrency set
if envReserveConcurrency < envReserveConcurrencyLimit then
    redis.call('SADD', envReserveConcurrencyKey, reserveMessageId)
end

return true
      `,
    });

    this.redis.defineCommand("enqueueMessageWithReservingConcurrencyOnRecursiveQueue", {
      numberOfKeys: 10,
      lua: `
local queueKey = KEYS[1]
local parentQueueKey = KEYS[2]
local messageKey = KEYS[3]
local queueCurrentConcurrencyKey = KEYS[4]
local queueReserveConcurrencyKey = KEYS[5]
local queueConcurrencyLimitKey = KEYS[6]
local envCurrentConcurrencyKey = KEYS[7]
local envReserveConcurrencyKey = KEYS[8]
local envConcurrencyLimitKey = KEYS[9]
local envQueueKey = KEYS[10]

local queueName = ARGV[1]
local messageId = ARGV[2]
local messageData = ARGV[3]
local messageScore = ARGV[4]
local reserveMessageId = ARGV[5]
local defaultEnvConcurrencyLimit = ARGV[6]

-- Get the env reserve concurrency limit because we need it to calculate the max reserve concurrency
-- for the specific queue
local envReserveConcurrencyLimit = tonumber(redis.call('GET', envConcurrencyLimitKey) or defaultEnvConcurrencyLimit)

-- Count the number of messages in the queue reserve concurrency set
local queueReserveConcurrency = tonumber(redis.call('SCARD', queueReserveConcurrencyKey) or '0')
local queueConcurrencyLimit = tonumber(redis.call('GET', queueConcurrencyLimitKey) or '1000000')

local queueReserveConcurrencyLimit = math.min(queueConcurrencyLimit, envReserveConcurrencyLimit)

-- If we cannot add the reserve concurrency, then we have to return false
if queueReserveConcurrency >= queueReserveConcurrencyLimit then
    return false
end

-- Write the message to the message key
redis.call('SET', messageKey, messageData)

-- Add the message to the queue
redis.call('ZADD', queueKey, messageScore, messageId)

-- Add the message to the env queue
redis.call('ZADD', envQueueKey, messageScore, messageId)

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueueKey, queueName)
else
    redis.call('ZADD', parentQueueKey, earliestMessage[2], queueName)
end

-- Update the concurrency keys
redis.call('SREM', queueCurrentConcurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
redis.call('SREM', envReserveConcurrencyKey, messageId)
redis.call('SREM', queueReserveConcurrencyKey, messageId)

-- Count the number of messages in the env reserve concurrency set
local envReserveConcurrency = tonumber(redis.call('SCARD', envReserveConcurrencyKey) or '0')

-- If there is space, add the messaageId to the env reserve concurrency set
if envReserveConcurrency < envReserveConcurrencyLimit then
    redis.call('SADD', envReserveConcurrencyKey, reserveMessageId)
end

redis.call('SADD', queueReserveConcurrencyKey, reserveMessageId)

return true
      `,
    });

    this.redis.defineCommand("dequeueMessage", {
      numberOfKeys: 9,
      lua: `
local queueKey = KEYS[1]
local parentQueueKey = KEYS[2]
local queueConcurrencyLimitKey = KEYS[3]
local envConcurrencyLimitKey = KEYS[4]
local queueCurrentConcurrencyKey = KEYS[5]
local queueReserveConcurrencyKey = KEYS[6]
local envCurrentConcurrencyKey = KEYS[7]
local envReserveConcurrencyKey = KEYS[8]
local envQueueKey = KEYS[9]

local queueName = ARGV[1]
local currentTime = tonumber(ARGV[2])
local defaultEnvConcurrencyLimit = ARGV[3]

-- Check current env concurrency against the limit
local envCurrentConcurrency = tonumber(redis.call('SCARD', envCurrentConcurrencyKey) or '0')
local envConcurrencyLimit = tonumber(redis.call('GET', envConcurrencyLimitKey) or defaultEnvConcurrencyLimit)
local envReserveConcurrency = tonumber(redis.call('SCARD', envReserveConcurrencyKey) or '0')
local totalEnvConcurrencyLimit = envConcurrencyLimit + envReserveConcurrency

if envCurrentConcurrency >= totalEnvConcurrencyLimit then
    return nil
end

-- Check current queue concurrency against the limit
local queueCurrentConcurrency = tonumber(redis.call('SCARD', queueCurrentConcurrencyKey) or '0')
local queueConcurrencyLimit = math.min(tonumber(redis.call('GET', queueConcurrencyLimitKey) or '1000000'), envConcurrencyLimit)
local queueReserveConcurrency = tonumber(redis.call('SCARD', queueReserveConcurrencyKey) or '0')
local totalQueueConcurrencyLimit = queueConcurrencyLimit + queueReserveConcurrency

-- Check condition only if concurrencyLimit exists
if queueCurrentConcurrency >= totalQueueConcurrencyLimit then
    return nil
end

-- Attempt to dequeue the next message
local messages = redis.call('ZRANGEBYSCORE', queueKey, '-inf', currentTime, 'WITHSCORES', 'LIMIT', 0, 1)

if #messages == 0 then
    return nil
end

local messageId = messages[1]
local messageScore = tonumber(messages[2])

-- Remove the message from the queue and update concurrency
redis.call('ZREM', queueKey, messageId)
redis.call('ZREM', envQueueKey, messageId)
redis.call('SADD', queueCurrentConcurrencyKey, messageId)
redis.call('SADD', envCurrentConcurrencyKey, messageId)

-- Remove the message from the reserve concurrency set
redis.call('SREM', envReserveConcurrencyKey, messageId)

-- Remove the message from the queue reserve concurrency set
redis.call('SREM', queueReserveConcurrencyKey, messageId)

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueueKey, queueName)
else
    redis.call('ZADD', parentQueueKey, earliestMessage[2], queueName)
end

return {messageId, messageScore} -- Return message details
      `,
    });

    this.redis.defineCommand("acknowledgeMessage", {
      numberOfKeys: 8,
      lua: `
local parentQueueKey = KEYS[1]
local messageKey = KEYS[2]
local queueKey = KEYS[3]
local queueConcurrencyKey = KEYS[4]
local queueReserveConcurrencyKey = KEYS[5]
local envCurrentConcurrencyKey = KEYS[6]
local envReserveConcurrencyKey = KEYS[7]
local envQueueKey = KEYS[8]

local messageId = ARGV[1]
local queueName = ARGV[2]

-- Remove the message from the queue
redis.call('ZREM', queueKey, messageId)

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueueKey, queueName)
else
    redis.call('ZADD', parentQueueKey, earliestMessage[2], queueName)
end

-- Update the concurrency keys
redis.call('SREM', queueConcurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
redis.call('SREM', envReserveConcurrencyKey, messageId)
redis.call('SREM', queueReserveConcurrencyKey, messageId)
redis.call('ZREM', envQueueKey, messageId)
redis.call('DEL', messageKey)
`,
    });

    this.redis.defineCommand("requeueMessage", {
      numberOfKeys: 8,
      lua: `
local queueKey = KEYS[1]
local parentQueueKey = KEYS[2]
local messageKey = KEYS[3]
local queueCurrentConcurrencyKey = KEYS[4]
local queueReserveConcurrencyKey = KEYS[5]
local envCurrentConcurrencyKey = KEYS[6]
local envReserveConcurrencyKey = KEYS[7]
local envQueueKey = KEYS[8]

local queueName = ARGV[1]
local messageId = ARGV[2]
local messageData = ARGV[3]
local messageScore = ARGV[4]

-- Write the new message data
redis.call('SET', messageKey, messageData)

-- Add the message to the queue with a new score
redis.call('ZADD', queueKey, messageScore, messageId)
redis.call('ZADD', envQueueKey, messageScore, messageId)

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueueKey, queueName)
else
    redis.call('ZADD', parentQueueKey, earliestMessage[2], queueName)
end

-- Clear all concurrency sets (combined from both scripts)
redis.call('SREM', queueCurrentConcurrencyKey, messageId)
redis.call('SREM', queueReserveConcurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
redis.call('SREM', envReserveConcurrencyKey, messageId)

return true
`,
    });

    this.redis.defineCommand("delayedRequeueMessage", {
      numberOfKeys: 5,
      lua: `
local messageKey = KEYS[1]
local queueCurrentConcurrencyKey = KEYS[2]
local queueReserveConcurrencyKey = KEYS[3]
local envCurrentConcurrencyKey = KEYS[4]
local envReserveConcurrencyKey = KEYS[5]

local messageId = ARGV[1]
local messageData = ARGV[2]

-- Write the new message data
redis.call('SET', messageKey, messageData)

-- Clear all concurrency sets
redis.call('SREM', queueCurrentConcurrencyKey, messageId)
redis.call('SREM', queueReserveConcurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
redis.call('SREM', envReserveConcurrencyKey, messageId)

return true
`,
    });

    this.redis.defineCommand("nackMessage", {
      numberOfKeys: 7,
      lua: `
local messageKey = KEYS[1]
local queueKey = KEYS[2]
local parentQueueKey = KEYS[3]
local queueCurrentConcurrencyKey = KEYS[4]
local envCurrentConcurrencyKey = KEYS[5]
local envQueueKey = KEYS[6]
local nackCounterKey = KEYS[7]

local queueName = ARGV[1]
local messageId = ARGV[2]
local currentTime = tonumber(ARGV[3])
local messageScore = tonumber(ARGV[4])

-- Update the current concurrency keys
redis.call('SREM', queueCurrentConcurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)

-- Enqueue the message into the queue
redis.call('ZADD', queueKey, messageScore, messageId)

-- Enqueue the message into the env queue
redis.call('ZADD', envQueueKey, messageScore, messageId)

-- Increment the nack counter with an expiry of 30 days
redis.call('INCR', nackCounterKey)
redis.call('EXPIRE', nackCounterKey, 2592000)

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueueKey, queueName)
else
    redis.call('ZADD', parentQueueKey, earliestMessage[2], queueName)
end
`,
    });

    this.redis.defineCommand("updateGlobalConcurrencyLimits", {
      numberOfKeys: 1,
      lua: `
local envConcurrencyLimitKey = KEYS[1]
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
      queueKey: string,
      parentQueueKey: string,
      messageKey: string,
      queueCurrentConcurrencyKey: string,
      queueReserveConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      envReserveConcurrencyKey: string,
      envQueueKey: string,
      queueName: string,
      messageId: string,
      messageData: string,
      messageScore: string,
      callback?: Callback<string>
    ): Result<string, Context>;

    enqueueMessageWithReservingConcurrency(
      queueKey: string,
      parentQueueKey: string,
      messageKey: string,
      queueCurrentConcurrencyKey: string,
      queueReserveConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      envReserveConcurrencyKey: string,
      envConcurrencyLimitKey: string,
      envQueueKey: string,
      queueName: string,
      messageId: string,
      messageData: string,
      messageScore: string,
      reserveMessageId: string,
      defaultEnvConcurrencyLimit: string,
      callback?: Callback<string>
    ): Result<string, Context>;

    enqueueMessageWithReservingConcurrencyOnRecursiveQueue(
      queueKey: string,
      parentQueueKey: string,
      messageKey: string,
      queueCurrentConcurrencyKey: string,
      queueReserveConcurrencyKey: string,
      queueConcurrencyLimitKey: string,
      envCurrentConcurrencyKey: string,
      envReserveConcurrencyKey: string,
      envConcurrencyLimitKey: string,
      envQueueKey: string,
      queueName: string,
      messageId: string,
      messageData: string,
      messageScore: string,
      reserveMessageId: string,
      defaultEnvConcurrencyLimit: string,
      callback?: Callback<string>
    ): Result<string, Context>;

    dequeueMessage(
      queueKey: string,
      parentQueueKey: string,
      queueConcurrencyLimitKey: string,
      envConcurrencyLimitKey: string,
      queueCurrentConcurrencyKey: string,
      queueReserveConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      envReserveConcurrencyKey: string,
      envQueueKey: string,
      queueName: string,
      currentTime: string,
      defaultEnvConcurrencyLimit: string,
      callback?: Callback<[string, string]>
    ): Result<[string, string] | null, Context>;

    requeueMessage(
      queueKey: string,
      parentQueueKey: string,
      messageKey: string,
      queueCurrentConcurrencyKey: string,
      queueReserveConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      envReserveConcurrencyKey: string,
      envQueueKey: string,
      queueName: string,
      messageId: string,
      messageData: string,
      messageScore: string,
      callback?: Callback<string>
    ): Result<string, Context>;

    delayedRequeueMessage(
      messageKey: string,
      queueCurrentConcurrencyKey: string,
      queueReserveConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      envReserveConcurrencyKey: string,
      messageId: string,
      messageData: string,
      callback?: Callback<string>
    ): Result<string, Context>;

    acknowledgeMessage(
      parentQueue: string,
      messageKey: string,
      messageQueue: string,
      concurrencyKey: string,
      queueReserveConcurrencyKey: string,
      envConcurrencyKey: string,
      envReserveConcurrencyKey: string,
      envQueueKey: string,
      messageId: string,
      messageQueueName: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    nackMessage(
      messageKey: string,
      queueKey: string,
      parentQueueKey: string,
      queueCurrentConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      envQueueKey: string,
      nackCounterKey: string,
      queueName: string,
      messageId: string,
      currentTime: string,
      messageScore: string,
      callback?: Callback<void>
    ): Result<void, Context>;

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

export const marqs = singleton("marqs", getMarQSClient);

function getMarQSClient() {
  if (!env.REDIS_HOST || !env.REDIS_PORT) {
    throw new Error(
      "Could not initialize Trigger.dev because process.env.REDIS_HOST and process.env.REDIS_PORT are required to be set."
    );
  }

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
    visibilityTimeoutStrategy: new V3LegacyRunEngineWorkerVisibilityTimeout(),
    queuePriorityStrategy: new FairDequeuingStrategy({
      tracer: tracer,
      redis,
      parentQueueLimit: env.MARQS_SHARED_QUEUE_LIMIT,
      keys: keysProducer,
      defaultEnvConcurrency: env.DEFAULT_ENV_EXECUTION_CONCURRENCY_LIMIT,
      biases: {
        concurrencyLimitBias: env.MARQS_CONCURRENCY_LIMIT_BIAS,
        availableCapacityBias: env.MARQS_AVAILABLE_CAPACITY_BIAS,
        queueAgeRandomization: env.MARQS_QUEUE_AGE_RANDOMIZATION_BIAS,
      },
      reuseSnapshotCount: env.MARQS_REUSE_SNAPSHOT_COUNT,
      maximumEnvCount: env.MARQS_MAXIMUM_ENV_COUNT,
      maximumQueuePerEnvCount: env.MARQS_MAXIMUM_QUEUE_PER_ENV_COUNT,
    }),
    envQueuePriorityStrategy: new FairDequeuingStrategy({
      tracer: tracer,
      redis,
      parentQueueLimit: env.MARQS_DEV_QUEUE_LIMIT,
      keys: keysProducer,
      defaultEnvConcurrency: env.DEFAULT_ENV_EXECUTION_CONCURRENCY_LIMIT,
      biases: {
        concurrencyLimitBias: 0.0,
        availableCapacityBias: 0.0,
        queueAgeRandomization: 0.1,
      },
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
}
