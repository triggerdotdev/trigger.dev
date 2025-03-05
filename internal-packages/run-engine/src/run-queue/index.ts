import { context, propagation, Span, SpanKind, SpanOptions, Tracer } from "@opentelemetry/api";
import {
  SEMATTRS_MESSAGE_ID,
  SEMATTRS_MESSAGING_OPERATION,
  SEMATTRS_MESSAGING_SYSTEM,
} from "@opentelemetry/semantic-conventions";
import { Logger } from "@trigger.dev/core/logger";
import { calculateNextRetryDelay, flattenAttributes } from "@trigger.dev/core/v3";
import { type RetryOptions } from "@trigger.dev/core/v3/schemas";
import { Redis, type Callback, type RedisOptions, type Result } from "ioredis";
import {
  attributesFromAuthenticatedEnv,
  MinimalAuthenticatedEnvironment,
} from "../shared/index.js";
import { RunQueueShortKeyProducer } from "./keyProducer.js";
import {
  InputPayload,
  OutputPayload,
  QueueCapacities,
  QueueRange,
  RunQueueKeyProducer,
  RunQueuePriorityStrategy,
} from "./types.js";
import { createRedisClient } from "@internal/redis";

const SemanticAttributes = {
  QUEUE: "runqueue.queue",
  MASTER_QUEUES: "runqueue.masterQueues",
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
  windowSize?: number;
  queuePriorityStrategy: RunQueuePriorityStrategy;
  envQueuePriorityStrategy: RunQueuePriorityStrategy;
  verbose?: boolean;
  logger: Logger;
  retryOptions?: RetryOptions;
};

type DequeuedMessage = {
  messageId: string;
  messageScore: string;
  message: OutputPayload;
};

const defaultRetrySettings = {
  maxAttempts: 12,
  factor: 2,
  minTimeoutInMs: 1_000,
  maxTimeoutInMs: 3_600_000,
  randomize: true,
};

/**
 * RunQueue – the queue that's used to process runs
 */
export class RunQueue {
  private retryOptions: RetryOptions;
  private subscriber: Redis;
  private logger: Logger;
  private redis: Redis;
  public keys: RunQueueKeyProducer;
  private queuePriorityStrategy: RunQueuePriorityStrategy;

  constructor(private readonly options: RunQueueOptions) {
    this.retryOptions = options.retryOptions ?? defaultRetrySettings;
    this.redis = createRedisClient(options.redis, {
      onError: (error) => {
        this.logger.error(`RunQueue redis client error:`, {
          error,
          keyPrefix: options.redis.keyPrefix,
        });
      },
    });
    this.logger = options.logger;

    this.keys = new RunQueueShortKeyProducer("rq:");
    this.queuePriorityStrategy = options.queuePriorityStrategy;

    this.subscriber = createRedisClient(options.redis, {
      onError: (error) => {
        this.logger.error(`RunQueue subscriber redis client error:`, {
          error,
          keyPrefix: options.redis.keyPrefix,
        });
      },
    });
    this.#setupSubscriber();

    this.#registerCommands();
  }

  get name() {
    return this.options.name;
  }

  get tracer() {
    return this.options.tracer;
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
    await this.#callUpdateGlobalConcurrencyLimits({
      envConcurrencyLimitKey: this.keys.envConcurrencyLimitKey(env),
      envConcurrencyLimit: env.maximumConcurrencyLimit,
    });
  }

  public async getEnvConcurrencyLimit(env: MinimalAuthenticatedEnvironment) {
    const result = await this.redis.get(this.keys.envConcurrencyLimitKey(env));

    return result ? Number(result) : this.options.defaultEnvConcurrency;
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

    return Number(result[1]);
  }

  public async currentConcurrencyOfQueue(
    env: MinimalAuthenticatedEnvironment,
    queue: string,
    concurrencyKey?: string
  ) {
    return this.redis.scard(this.keys.currentConcurrencyKey(env, queue, concurrencyKey));
  }

  public async currentConcurrencyOfEnvironment(env: MinimalAuthenticatedEnvironment) {
    return this.redis.scard(this.keys.envCurrentConcurrencyKey(env));
  }

  public async currentConcurrencyOfProject(env: MinimalAuthenticatedEnvironment) {
    return this.redis.scard(this.keys.projectCurrentConcurrencyKey(env));
  }

  public async currentConcurrencyOfTask(
    env: MinimalAuthenticatedEnvironment,
    taskIdentifier: string
  ) {
    return this.redis.scard(this.keys.taskIdentifierCurrentConcurrencyKey(env, taskIdentifier));
  }

  public async enqueueMessage({
    env,
    message,
    masterQueues,
  }: {
    env: MinimalAuthenticatedEnvironment;
    message: InputPayload;
    masterQueues: string | string[];
  }) {
    return await this.#trace(
      "enqueueMessage",
      async (span) => {
        const { runId, concurrencyKey } = message;

        const queue = this.keys.queueKey(env, message.queue, concurrencyKey);

        propagation.inject(context.active(), message);

        const parentQueues = typeof masterQueues === "string" ? [masterQueues] : masterQueues;

        span.setAttributes({
          [SemanticAttributes.QUEUE]: queue,
          [SemanticAttributes.RUN_ID]: runId,
          [SemanticAttributes.CONCURRENCY_KEY]: concurrencyKey,
          [SemanticAttributes.MASTER_QUEUES]: parentQueues.join(","),
        });

        const messagePayload: OutputPayload = {
          ...message,
          version: "1",
          queue,
          masterQueues: parentQueues,
          attempt: 0,
        };

        await this.#callEnqueueMessage(messagePayload, parentQueues);
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

  public async getSharedQueueDetails(masterQueue: string, maxCount: number) {
    const { range } = await this.queuePriorityStrategy.nextCandidateSelection(
      masterQueue,
      "getSharedQueueDetails"
    );
    const queues = await this.#getChildQueuesWithScores(masterQueue, range);

    const queuesWithScores = await this.#calculateQueueScores(queues, (queue) =>
      this.#calculateMessageQueueCapacities(queue)
    );

    // We need to priority shuffle here to ensure all workers aren't just working on the highest priority queue
    const result = this.queuePriorityStrategy.chooseQueues(
      queuesWithScores,
      masterQueue,
      "getSharedQueueDetails",
      range,
      maxCount
    );

    return {
      selectionId: "getSharedQueueDetails",
      queues,
      queuesWithScores,
      nextRange: range,
      queueCount: queues.length,
      queueChoice: result,
    };
  }

  /**
   * Dequeue messages from the master queue
   */
  public async dequeueMessageFromMasterQueue(
    consumerId: string,
    masterQueue: string,
    maxCount: number
  ): Promise<DequeuedMessage[]> {
    return this.#trace(
      "dequeueMessageInSharedQueue",
      async (span) => {
        // Read the parent queue for matching queues
        const selectedQueues = await this.#getRandomQueueFromParentQueue(
          masterQueue,
          this.options.queuePriorityStrategy,
          (queue) => this.#calculateMessageQueueCapacities(queue, { checkForDisabled: true }),
          consumerId,
          maxCount
        );

        if (!selectedQueues || selectedQueues.length === 0) {
          return [];
        }

        const messages: DequeuedMessage[] = [];
        const remainingMessages = selectedQueues.map((q) => q.size);
        let currentQueueIndex = 0;

        while (messages.length < maxCount) {
          let foundMessage = false;

          // Try each queue once in this round
          for (let i = 0; i < selectedQueues.length; i++) {
            currentQueueIndex = (currentQueueIndex + i) % selectedQueues.length;

            // Skip if this queue is empty
            if (remainingMessages[currentQueueIndex] <= 0) continue;

            const selectedQueue = selectedQueues[currentQueueIndex];
            const queue = selectedQueue.queue;

            const message = await this.#callDequeueMessage({
              messageQueue: queue,
              concurrencyLimitKey: this.keys.concurrencyLimitKeyFromQueue(queue),
              currentConcurrencyKey: this.keys.currentConcurrencyKeyFromQueue(queue),
              envConcurrencyLimitKey: this.keys.envConcurrencyLimitKeyFromQueue(queue),
              envCurrentConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(queue),
              projectCurrentConcurrencyKey: this.keys.projectCurrentConcurrencyKeyFromQueue(queue),
              messageKeyPrefix: this.keys.messageKeyPrefixFromQueue(queue),
              envQueueKey: this.keys.envQueueKeyFromQueue(queue),
              taskCurrentConcurrentKeyPrefix:
                this.keys.taskIdentifierCurrentConcurrencyKeyPrefixFromQueue(queue),
            });

            if (message) {
              messages.push(message);
              remainingMessages[currentQueueIndex]--;
              foundMessage = true;
              break;
            } else {
              // If we failed to get a message, mark this queue as empty
              remainingMessages[currentQueueIndex] = 0;
            }
          }

          // If we couldn't get a message from any queue, break
          if (!foundMessage) break;
        }

        span.setAttributes({
          [SemanticAttributes.RESULT_COUNT]: messages.length,
          [SemanticAttributes.MASTER_QUEUES]: masterQueue,
        });

        return messages;
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
   * @param messageId
   */
  public async acknowledgeMessage(orgId: string, messageId: string) {
    return this.#trace(
      "acknowledgeMessage",
      async (span) => {
        const message = await this.#readMessage(orgId, messageId);

        if (!message) {
          this.logger.log(`[${this.name}].acknowledgeMessage() message not found`, {
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

        await this.#callAcknowledgeMessage({
          messageId,
          messageQueue: message.queue,
          masterQueues: message.masterQueues,
          messageKey: this.keys.messageKey(orgId, messageId),
          concurrencyKey: this.keys.currentConcurrencyKeyFromQueue(message.queue),
          envConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(message.queue),
          taskConcurrencyKey: this.keys.taskIdentifierCurrentConcurrencyKeyFromQueue(
            message.queue,
            message.taskIdentifier
          ),
          envQueueKey: this.keys.envQueueKeyFromQueue(message.queue),
          projectConcurrencyKey: this.keys.projectCurrentConcurrencyKeyFromQueue(message.queue),
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
  }: {
    orgId: string;
    messageId: string;
    retryAt?: number;
    incrementAttemptCount?: boolean;
  }) {
    return this.#trace(
      "nackMessage",
      async (span) => {
        const maxAttempts = this.retryOptions.maxAttempts ?? defaultRetrySettings.maxAttempts;

        const message = await this.#readMessage(orgId, messageId);
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
          [SemanticAttributes.MASTER_QUEUES]: message.masterQueues.join(","),
        });

        const messageKey = this.keys.messageKey(orgId, messageId);
        const messageQueue = message.queue;
        const concurrencyKey = this.keys.currentConcurrencyKeyFromQueue(message.queue);
        const envConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
        const taskConcurrencyKey = this.keys.taskIdentifierCurrentConcurrencyKeyFromQueue(
          message.queue,
          message.taskIdentifier
        );
        const projectConcurrencyKey = this.keys.projectCurrentConcurrencyKeyFromQueue(
          message.queue
        );
        const envQueueKey = this.keys.envQueueKeyFromQueue(message.queue);

        if (incrementAttemptCount) {
          message.attempt = message.attempt + 1;
          if (message.attempt >= maxAttempts) {
            await this.redis.moveToDeadLetterQueue(
              messageKey,
              messageQueue,
              concurrencyKey,
              envConcurrencyKey,
              projectConcurrencyKey,
              envQueueKey,
              taskConcurrencyKey,
              "dlq",
              messageId,
              JSON.stringify(message.masterQueues),
              this.options.redis.keyPrefix ?? ""
            );
            return false;
          }
        }

        const nextRetryDelay = calculateNextRetryDelay(this.retryOptions, message.attempt);
        const messageScore = retryAt ?? (nextRetryDelay ? Date.now() + nextRetryDelay : Date.now());

        this.logger.debug("Calling nackMessage", {
          messageKey,
          messageQueue,
          masterQueues: message.masterQueues,
          concurrencyKey,
          envConcurrencyKey,
          projectConcurrencyKey,
          envQueueKey,
          taskConcurrencyKey,
          messageId,
          messageScore,
          attempt: message.attempt,
          service: this.name,
        });

        await this.redis.nackMessage(
          //keys
          messageKey,
          messageQueue,
          concurrencyKey,
          envConcurrencyKey,
          projectConcurrencyKey,
          envQueueKey,
          taskConcurrencyKey,
          //args
          messageId,
          JSON.stringify(message),
          String(messageScore),
          JSON.stringify(message.masterQueues),
          this.options.redis.keyPrefix ?? ""
        );
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

  public async releaseConcurrency(
    orgId: string,
    messageId: string,
    releaseForRun: boolean = false
  ) {
    return this.#trace(
      "releaseConcurrency",
      async (span) => {
        const message = await this.#readMessage(orgId, messageId);

        if (!message) {
          this.logger.log(`[${this.name}].acknowledgeMessage() message not found`, {
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
          this.keys.messageKey(orgId, messageId),
          message.queue,
          releaseForRun ? this.keys.currentConcurrencyKeyFromQueue(message.queue) : "",
          this.keys.envCurrentConcurrencyKeyFromQueue(message.queue),
          this.keys.projectCurrentConcurrencyKeyFromQueue(message.queue),
          this.keys.taskIdentifierCurrentConcurrencyKeyFromQueue(
            message.queue,
            message.taskIdentifier
          ),
          messageId,
          JSON.stringify(message.masterQueues)
        );
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

  public async reacquireConcurrency(orgId: string, messageId: string) {
    return this.#trace(
      "reacquireConcurrency",
      async (span) => {
        const message = await this.#readMessage(orgId, messageId);

        if (!message) {
          this.logger.log(`[${this.name}].acknowledgeMessage() message not found`, {
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

        return this.redis.reacquireConcurrency(
          this.keys.messageKey(orgId, messageId),
          message.queue,
          this.keys.currentConcurrencyKeyFromQueue(message.queue),
          this.keys.envCurrentConcurrencyKeyFromQueue(message.queue),
          this.keys.projectCurrentConcurrencyKeyFromQueue(message.queue),
          this.keys.taskIdentifierCurrentConcurrencyKeyFromQueue(
            message.queue,
            message.taskIdentifier
          ),
          messageId,
          JSON.stringify(message.masterQueues)
        );
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

  async quit() {
    await this.subscriber.unsubscribe();
    await this.subscriber.quit();
    await this.redis.quit();
  }

  private async handleRedriveMessage(channel: string, message: string) {
    try {
      const { runId, orgId } = JSON.parse(message) as any;
      if (typeof orgId !== "string" || typeof runId !== "string") {
        this.logger.error(
          "handleRedriveMessage: invalid message format: runId and orgId must be strings",
          { message, channel }
        );
        return;
      }

      const data = await this.#readMessage(orgId, runId);

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
        masterQueues: data.masterQueues,
      });

      //remove from the dlq
      const result = await this.redis.zrem("dlq", runId);

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

  async #readMessage(orgId: string, messageId: string) {
    return this.#trace(
      "readMessage",
      async (span) => {
        const rawMessage = await this.redis.get(this.keys.messageKey(orgId, messageId));

        if (!rawMessage) {
          return;
        }

        const message = OutputPayload.safeParse(JSON.parse(rawMessage));

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
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
          [SemanticAttributes.RUN_ID]: messageId,
        },
      }
    );
  }

  async #getRandomQueueFromParentQueue(
    parentQueue: string,
    queuePriorityStrategy: RunQueuePriorityStrategy,
    calculateCapacities: (queue: string) => Promise<QueueCapacities>,
    consumerId: string,
    maxCount: number
  ): Promise<
    | {
        queue: string;
        capacities: QueueCapacities;
        age: number;
        size: number;
      }[]
    | undefined
  > {
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
        const { choices, nextRange } = queuePriorityStrategy.chooseQueues(
          queuesWithScores,
          parentQueue,
          consumerId,
          range,
          maxCount
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
          if (Array.isArray(choices)) {
            this.logger.debug(`[${this.name}] getRandomQueueFromParentQueue`, {
              queues,
              queuesWithScores,
              range,
              nextRange,
              queueCount: queues.length,
              queuesWithScoresCount: queuesWithScores.length,
              queueChoices: choices,
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

        if (Array.isArray(choices)) {
          span.setAttribute("queueChoices", choices);
          return queuesWithScores.filter((queue) => choices.includes(queue.queue));
        } else {
          span.setAttribute("noQueueChoice", true);
          return;
        }
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "receive",
          [SEMATTRS_MESSAGING_SYSTEM]: "runqueue",
          [SemanticAttributes.MASTER_QUEUES]: parentQueue,
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

  async #callEnqueueMessage(message: OutputPayload, masterQueues: string[]) {
    const concurrencyKey = this.keys.currentConcurrencyKeyFromQueue(message.queue);
    const envConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
    const taskConcurrencyKey = this.keys.taskIdentifierCurrentConcurrencyKeyFromQueue(
      message.queue,
      message.taskIdentifier
    );
    const projectConcurrencyKey = this.keys.projectCurrentConcurrencyKeyFromQueue(message.queue);

    this.logger.debug("Calling enqueueMessage", {
      messagePayload: message,
      concurrencyKey,
      envConcurrencyKey,
      masterQueues,
      service: this.name,
    });

    return this.redis.enqueueMessage(
      message.queue,
      this.keys.messageKey(message.orgId, message.runId),
      concurrencyKey,
      envConcurrencyKey,
      taskConcurrencyKey,
      projectConcurrencyKey,
      this.keys.envQueueKeyFromQueue(message.queue),
      message.queue,
      message.runId,
      JSON.stringify(message),
      String(message.timestamp),
      JSON.stringify(masterQueues),
      this.options.redis.keyPrefix ?? ""
    );
  }

  async #callDequeueMessage({
    messageQueue,
    concurrencyLimitKey,
    envConcurrencyLimitKey,
    currentConcurrencyKey,
    envCurrentConcurrencyKey,
    projectCurrentConcurrencyKey,
    messageKeyPrefix,
    envQueueKey,
    taskCurrentConcurrentKeyPrefix,
  }: {
    messageQueue: string;
    concurrencyLimitKey: string;
    envConcurrencyLimitKey: string;
    currentConcurrencyKey: string;
    envCurrentConcurrencyKey: string;
    projectCurrentConcurrencyKey: string;
    messageKeyPrefix: string;
    envQueueKey: string;
    taskCurrentConcurrentKeyPrefix: string;
  }): Promise<DequeuedMessage | undefined> {
    const result = await this.redis.dequeueMessage(
      //keys
      messageQueue,
      concurrencyLimitKey,
      envConcurrencyLimitKey,
      currentConcurrencyKey,
      envCurrentConcurrencyKey,
      projectCurrentConcurrencyKey,
      messageKeyPrefix,
      envQueueKey,
      taskCurrentConcurrentKeyPrefix,
      //args
      messageQueue,
      String(Date.now()),
      String(this.options.defaultEnvConcurrency),
      this.options.redis.keyPrefix ?? ""
    );

    if (!result) {
      return;
    }

    this.logger.debug("Dequeue message result", {
      result,
      service: this.name,
    });

    if (result.length !== 3) {
      this.logger.error("Invalid dequeue message result", {
        result,
        service: this.name,
      });
      return;
    }

    const [messageId, messageScore, rawMessage] = result;

    //read message
    const parsedMessage = OutputPayload.safeParse(JSON.parse(rawMessage));
    if (!parsedMessage.success) {
      this.logger.error(`[${this.name}] Failed to parse message`, {
        messageId,
        error: parsedMessage.error,
        service: this.name,
      });

      return;
    }

    const message = parsedMessage.data;

    return {
      messageId,
      messageScore,
      message,
    };
  }

  async #callAcknowledgeMessage({
    messageId,
    masterQueues,
    messageKey,
    messageQueue,
    concurrencyKey,
    envConcurrencyKey,
    taskConcurrencyKey,
    envQueueKey,
    projectConcurrencyKey,
  }: {
    masterQueues: string[];
    messageKey: string;
    messageQueue: string;
    concurrencyKey: string;
    envConcurrencyKey: string;
    taskConcurrencyKey: string;
    envQueueKey: string;
    projectConcurrencyKey: string;
    messageId: string;
  }) {
    this.logger.debug("Calling acknowledgeMessage", {
      messageKey,
      messageQueue,
      concurrencyKey,
      envConcurrencyKey,
      projectConcurrencyKey,
      envQueueKey,
      taskConcurrencyKey,
      messageId,
      masterQueues,
      service: this.name,
    });

    return this.redis.acknowledgeMessage(
      messageKey,
      messageQueue,
      concurrencyKey,
      envConcurrencyKey,
      projectConcurrencyKey,
      envQueueKey,
      taskConcurrencyKey,
      messageId,
      JSON.stringify(masterQueues),
      this.options.redis.keyPrefix ?? ""
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
    const isOrgEnabled = Boolean(capacities[4]);
    const queueLimit = capacities[1]
      ? Number(capacities[1])
      : Math.min(envLimit, isOrgEnabled ? Infinity : 0);
    const envCurrent = Number(capacities[2]);

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

  #registerCommands() {
    this.redis.defineCommand("enqueueMessage", {
      numberOfKeys: 7,
      lua: `
local queue = KEYS[1]
local messageKey = KEYS[2]
local concurrencyKey = KEYS[3]
local envConcurrencyKey = KEYS[4]
local taskConcurrencyKey = KEYS[5]
local projectConcurrencyKey = KEYS[6]
local envQueueKey = KEYS[7]

local queueName = ARGV[1]
local messageId = ARGV[2]
local messageData = ARGV[3]
local messageScore = ARGV[4]
local parentQueues = cjson.decode(ARGV[5])
local keyPrefix = ARGV[6]

-- Write the message to the message key
redis.call('SET', messageKey, messageData)

-- Add the message to the queue
redis.call('ZADD', queue, messageScore, messageId)

-- Add the message to the env queue
redis.call('ZADD', envQueueKey, messageScore, messageId)

-- Rebalance the parent queues
local earliestMessage = redis.call('ZRANGE', queue, 0, 0, 'WITHSCORES')

for _, parentQueue in ipairs(parentQueues) do
    local prefixedParentQueue = keyPrefix .. parentQueue
    if #earliestMessage == 0 then
        redis.call('ZREM', prefixedParentQueue, queueName)
    else
        redis.call('ZADD', prefixedParentQueue, earliestMessage[2], queueName)
    end
end

-- Update the concurrency keys
redis.call('SREM', concurrencyKey, messageId)
redis.call('SREM', envConcurrencyKey, messageId)
redis.call('SREM', taskConcurrencyKey, messageId)
redis.call('SREM', projectConcurrencyKey, messageId)
      `,
    });

    this.redis.defineCommand("dequeueMessage", {
      numberOfKeys: 9,
      lua: `
local childQueue = KEYS[1]
local concurrencyLimitKey = KEYS[2]
local envConcurrencyLimitKey = KEYS[3]
local currentConcurrencyKey = KEYS[4]
local envCurrentConcurrencyKey = KEYS[5]
local projectConcurrencyKey = KEYS[6]
local messageKeyPrefix = KEYS[7]
local envQueueKey = KEYS[8]
local taskCurrentConcurrentKeyPrefix = KEYS[9]

local childQueueName = ARGV[1]
local currentTime = tonumber(ARGV[2])
local defaultEnvConcurrencyLimit = ARGV[3]
local keyPrefix = ARGV[4]

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

-- Get the message payload
local messageKey = messageKeyPrefix .. messageId
local messagePayload = redis.call('GET', messageKey)
local decodedPayload = cjson.decode(messagePayload);

-- Extract taskIdentifier
local taskIdentifier = decodedPayload.taskIdentifier

-- Perform SADD with taskIdentifier and messageId
local taskConcurrencyKey = taskCurrentConcurrentKeyPrefix .. taskIdentifier

-- Update concurrency
redis.call('ZREM', childQueue, messageId)
redis.call('ZREM', envQueueKey, messageId)
redis.call('SADD', currentConcurrencyKey, messageId)
redis.call('SADD', envCurrentConcurrencyKey, messageId)
redis.call('SADD', projectConcurrencyKey, messageId)
redis.call('SADD', taskConcurrencyKey, messageId)

-- Rebalance the parent queues
local earliestMessage = redis.call('ZRANGE', childQueue, 0, 0, 'WITHSCORES')
for _, parentQueue in ipairs(decodedPayload.masterQueues) do
    local prefixedParentQueue = keyPrefix .. parentQueue
    if #earliestMessage == 0 then
        redis.call('ZREM', prefixedParentQueue, childQueue)
    else
        redis.call('ZADD', prefixedParentQueue, earliestMessage[2], childQueue)
    end
end

return {messageId, messageScore, messagePayload} -- Return message details
      `,
    });

    this.redis.defineCommand("acknowledgeMessage", {
      numberOfKeys: 7,
      lua: `
-- Keys:
local messageKey = KEYS[1]
local messageQueue = KEYS[2]
local concurrencyKey = KEYS[3]
local envCurrentConcurrencyKey = KEYS[4]
local projectCurrentConcurrencyKey = KEYS[5]
local envQueueKey = KEYS[6]
local taskCurrentConcurrencyKey = KEYS[7]

-- Args:
local messageId = ARGV[1]
local parentQueues = cjson.decode(ARGV[2])
local keyPrefix = ARGV[3]

-- Remove the message from the message key
redis.call('DEL', messageKey)

-- Remove the message from the queue
redis.call('ZREM', messageQueue, messageId)
redis.call('ZREM', envQueueKey, messageId)

-- Rebalance the parent queues
local earliestMessage = redis.call('ZRANGE', messageQueue, 0, 0, 'WITHSCORES')
for _, parentQueue in ipairs(parentQueues) do
  local prefixedParentQueue = keyPrefix .. parentQueue
    if #earliestMessage == 0 then
        redis.call('ZREM', prefixedParentQueue, messageQueue)
    else
        redis.call('ZADD', prefixedParentQueue, earliestMessage[2], messageQueue)
    end
end

-- Update the concurrency keys
redis.call('SREM', concurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
redis.call('SREM', projectCurrentConcurrencyKey, messageId)
redis.call('SREM', taskCurrentConcurrencyKey, messageId)
`,
    });

    this.redis.defineCommand("nackMessage", {
      numberOfKeys: 7,
      lua: `
-- Keys:
local messageKey = KEYS[1]
local messageQueueKey = KEYS[2]
local concurrencyKey = KEYS[3]
local envConcurrencyKey = KEYS[4]
local projectConcurrencyKey = KEYS[5]
local envQueueKey = KEYS[6]
local taskConcurrencyKey = KEYS[7]

-- Args:
local messageId = ARGV[1]
local messageData = ARGV[2]
local messageScore = tonumber(ARGV[3])
local parentQueues = cjson.decode(ARGV[4])
local keyPrefix = ARGV[5]

-- Update the message data
redis.call('SET', messageKey, messageData)

-- Update the concurrency keys
redis.call('SREM', concurrencyKey, messageId)
redis.call('SREM', envConcurrencyKey, messageId)
redis.call('SREM', projectConcurrencyKey, messageId)
redis.call('SREM', taskConcurrencyKey, messageId)

-- Enqueue the message into the queue
redis.call('ZADD', messageQueueKey, messageScore, messageId)
redis.call('ZADD', envQueueKey, messageScore, messageId)

-- Rebalance the parent queues
local earliestMessage = redis.call('ZRANGE', messageQueueKey, 0, 0, 'WITHSCORES')
for _, parentQueue in ipairs(parentQueues) do
    local prefixedParentQueue = keyPrefix .. parentQueue
    if #earliestMessage == 0 then
        redis.call('ZREM', prefixedParentQueue, messageQueueKey)
    else
        redis.call('ZADD', prefixedParentQueue, earliestMessage[2], messageQueueKey)
    end
end
`,
    });

    this.redis.defineCommand("moveToDeadLetterQueue", {
      numberOfKeys: 8,
      lua: `
-- Keys:
local messageKey = KEYS[1]
local messageQueue = KEYS[2]
local concurrencyKey = KEYS[3]
local envCurrentConcurrencyKey = KEYS[4]
local projectCurrentConcurrencyKey = KEYS[5]
local envQueueKey = KEYS[6]
local taskCurrentConcurrencyKey = KEYS[7]
local deadLetterQueueKey = KEYS[8]

-- Args:
local messageId = ARGV[1]
local parentQueues = cjson.decode(ARGV[2])
local keyPrefix = ARGV[3]

-- Remove the message from the queue
redis.call('ZREM', messageQueue, messageId)
redis.call('ZREM', envQueueKey, messageId)

-- Rebalance the parent queues
local earliestMessage = redis.call('ZRANGE', messageQueue, 0, 0, 'WITHSCORES')
for _, parentQueue in ipairs(parentQueues) do
    local prefixedParentQueue = keyPrefix .. parentQueue
    if #earliestMessage == 0 then
        redis.call('ZREM', prefixedParentQueue, messageQueue)
    else
        redis.call('ZADD', prefixedParentQueue, earliestMessage[2], messageQueue)
    end
end

-- Add the message to the dead letter queue
redis.call('ZADD', deadLetterQueueKey, tonumber(redis.call('TIME')[1]), messageId)

-- Update the concurrency keys
redis.call('SREM', concurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
redis.call('SREM', projectCurrentConcurrencyKey, messageId)
redis.call('SREM', taskCurrentConcurrencyKey, messageId)
`,
    });

    this.redis.defineCommand("releaseConcurrency", {
      numberOfKeys: 6,
      lua: `
-- Keys:
local messageKey = KEYS[1]
local messageQueue = KEYS[2]
local concurrencyKey = KEYS[3]
local envCurrentConcurrencyKey = KEYS[4]
local projectCurrentConcurrencyKey = KEYS[5]
local taskCurrentConcurrencyKey = KEYS[6]

-- Args:
local messageId = ARGV[1]

-- Update the concurrency keys
if concurrencyKey ~= "" then
  redis.call('SREM', concurrencyKey, messageId)
end
redis.call('SREM', envCurrentConcurrencyKey, messageId)
redis.call('SREM', projectCurrentConcurrencyKey, messageId)
redis.call('SREM', taskCurrentConcurrencyKey, messageId)
`,
    });

    this.redis.defineCommand("reacquireConcurrency", {
      numberOfKeys: 6,
      lua: `
-- Keys:
local messageKey = KEYS[1]
local messageQueue = KEYS[2]
local concurrencyKey = KEYS[3]
local envCurrentConcurrencyKey = KEYS[4]
local projectCurrentConcurrencyKey = KEYS[5]
local taskCurrentConcurrencyKey = KEYS[6]

-- Args:
local messageId = ARGV[1]

-- Update the concurrency keys
redis.call('SADD', concurrencyKey, messageId)
redis.call('SADD', envCurrentConcurrencyKey, messageId)
redis.call('SADD', projectCurrentConcurrencyKey, messageId)
redis.call('SADD', taskCurrentConcurrencyKey, messageId)
`,
    });

    this.redis.defineCommand("calculateMessageQueueCapacitiesWithDisabling", {
      numberOfKeys: 5,
      lua: `
-- Keys
local currentConcurrencyKey = KEYS[1]
local currentEnvConcurrencyKey = KEYS[2]
local concurrencyLimitKey = KEYS[3]
local envConcurrencyLimitKey = KEYS[4]
local disabledConcurrencyLimitKey = KEYS[5]

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
return { currentConcurrency, concurrencyLimit, currentEnvConcurrency, envConcurrencyLimit, orgIsEnabled }
      `,
    });

    this.redis.defineCommand("calculateMessageQueueCapacities", {
      numberOfKeys: 4,
      lua: `
-- Keys:
local currentConcurrencyKey = KEYS[1]
local currentEnvConcurrencyKey = KEYS[2]
local concurrencyLimitKey = KEYS[3]
local envConcurrencyLimitKey = KEYS[4]

-- Args
local defaultEnvConcurrencyLimit = tonumber(ARGV[1])

local currentEnvConcurrency = tonumber(redis.call('SCARD', currentEnvConcurrencyKey) or '0')
local envConcurrencyLimit = tonumber(redis.call('GET', envConcurrencyLimitKey) or defaultEnvConcurrencyLimit)

local currentConcurrency = tonumber(redis.call('SCARD', currentConcurrencyKey) or '0')
local concurrencyLimit = redis.call('GET', concurrencyLimitKey)

-- Return current capacity and concurrency limits for the queue, env, org
return { currentConcurrency, concurrencyLimit, currentEnvConcurrency, envConcurrencyLimit, true }
      `,
    });

    this.redis.defineCommand("updateGlobalConcurrencyLimits", {
      numberOfKeys: 1,
      lua: `
-- Keys: envConcurrencyLimitKey
local envConcurrencyLimitKey = KEYS[1]

-- Args: envConcurrencyLimit
local envConcurrencyLimit = ARGV[1]

redis.call('SET', envConcurrencyLimitKey, envConcurrencyLimit)
      `,
    });
  }
}

declare module "ioredis" {
  interface RedisCommander<Context> {
    enqueueMessage(
      //keys
      queue: string,
      messageKey: string,
      concurrencyKey: string,
      envConcurrencyKey: string,
      taskConcurrencyKey: string,
      projectConcurrencyKey: string,
      envQueueKey: string,
      //args
      queueName: string,
      messageId: string,
      messageData: string,
      messageScore: string,
      parentQueues: string,
      keyPrefix: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    dequeueMessage(
      //keys
      childQueue: string,
      concurrencyLimitKey: string,
      envConcurrencyLimitKey: string,
      currentConcurrencyKey: string,
      envConcurrencyKey: string,
      projectConcurrencyKey: string,
      messageKeyPrefix: string,
      envQueueKey: string,
      taskCurrentConcurrentKeyPrefix: string,
      //args
      childQueueName: string,
      currentTime: string,
      defaultEnvConcurrencyLimit: string,
      keyPrefix: string,
      callback?: Callback<[string, string]>
    ): Result<[string, string, string] | null, Context>;

    acknowledgeMessage(
      messageKey: string,
      messageQueue: string,
      concurrencyKey: string,
      envConcurrencyKey: string,
      projectConcurrencyKey: string,
      envQueueKey: string,
      taskConcurrencyKey: string,
      messageId: string,
      masterQueues: string,
      keyPrefix: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    nackMessage(
      messageKey: string,
      messageQueue: string,
      concurrencyKey: string,
      envConcurrencyKey: string,
      projectConcurrencyKey: string,
      envQueueKey: string,
      taskConcurrencyKey: string,
      messageId: string,
      messageData: string,
      messageScore: string,
      masterQueues: string,
      keyPrefix: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    moveToDeadLetterQueue(
      messageKey: string,
      messageQueue: string,
      concurrencyKey: string,
      envConcurrencyKey: string,
      projectConcurrencyKey: string,
      envQueueKey: string,
      taskConcurrencyKey: string,
      deadLetterQueueKey: string,
      messageId: string,
      masterQueues: string,
      keyPrefix: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    releaseConcurrency(
      messageKey: string,
      messageQueue: string,
      concurrencyKey: string,
      envConcurrencyKey: string,
      projectConcurrencyKey: string,
      taskConcurrencyKey: string,
      messageId: string,
      masterQueues: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    reacquireConcurrency(
      messageKey: string,
      messageQueue: string,
      concurrencyKey: string,
      envConcurrencyKey: string,
      projectConcurrencyKey: string,
      taskConcurrencyKey: string,
      messageId: string,
      masterQueues: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    calculateMessageQueueCapacities(
      currentConcurrencyKey: string,
      currentEnvConcurrencyKey: string,
      concurrencyLimitKey: string,
      envConcurrencyLimitKey: string,
      defaultEnvConcurrencyLimit: string,
      callback?: Callback<number[]>
    ): Result<[number, number, number, number, boolean], Context>;

    calculateMessageQueueCapacitiesWithDisabling(
      currentConcurrencyKey: string,
      currentEnvConcurrencyKey: string,
      concurrencyLimitKey: string,
      envConcurrencyLimitKey: string,
      disabledConcurrencyLimitKey: string,
      defaultEnvConcurrencyLimit: string,
      callback?: Callback<number[]>
    ): Result<[number, number, number, number, boolean], Context>;

    updateGlobalConcurrencyLimits(
      envConcurrencyLimitKey: string,
      envConcurrencyLimit: string,
      callback?: Callback<void>
    ): Result<void, Context>;
  }
}
