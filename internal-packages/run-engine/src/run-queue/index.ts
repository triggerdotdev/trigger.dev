import {
  context,
  propagation,
  Span,
  SpanKind,
  SpanOptions,
  Tracer,
  SEMATTRS_MESSAGE_ID,
  SEMATTRS_MESSAGING_OPERATION,
  SEMATTRS_MESSAGING_SYSTEM,
} from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { calculateNextRetryDelay } from "@trigger.dev/core/v3";
import { type RetryOptions } from "@trigger.dev/core/v3/schemas";
import {
  attributesFromAuthenticatedEnv,
  MinimalAuthenticatedEnvironment,
} from "../shared/index.js";
import {
  InputPayload,
  OutputPayload,
  RunQueueKeyProducer,
  RunQueueSelectionStrategy,
} from "./types.js";
import {
  createRedisClient,
  type Redis,
  type Callback,
  type RedisOptions,
  type Result,
} from "@internal/redis";
import { MessageNotFoundError } from "./errors.js";
import { tryCatch } from "@trigger.dev/core";

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
  keys: RunQueueKeyProducer;
  queueSelectionStrategy: RunQueueSelectionStrategy;
  verbose?: boolean;
  logger?: Logger;
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
  private queueSelectionStrategy: RunQueueSelectionStrategy;

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
    this.logger = options.logger ?? new Logger("RunQueue", "warn");

    this.keys = options.keys;
    this.queueSelectionStrategy = options.queueSelectionStrategy;

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

    return Number(result[1]);
  }

  public async currentConcurrencyOfQueue(
    env: MinimalAuthenticatedEnvironment,
    queue: string,
    concurrencyKey?: string
  ) {
    return this.redis.scard(this.keys.currentConcurrencyKey(env, queue, concurrencyKey));
  }

  public async currentConcurrencyOfQueues(
    env: MinimalAuthenticatedEnvironment,
    queues: string[]
  ): Promise<Record<string, number>> {
    const pipeline = this.redis.pipeline();

    // Queue up all SCARD commands in the pipeline
    queues.forEach((queue) => {
      pipeline.scard(this.keys.currentConcurrencyKey(env, queue));
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

  public async currentConcurrencyOfEnvironment(env: MinimalAuthenticatedEnvironment) {
    return this.redis.scard(this.keys.envCurrentConcurrencyKey(env));
  }

  public async messageExists(orgId: string, messageId: string) {
    return this.redis.exists(this.keys.messageKey(orgId, messageId));
  }

  public async readMessage(orgId: string, messageId: string) {
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

        return await this.#callEnqueueMessage(messagePayload, parentQueues);
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
        const envQueues = await this.queueSelectionStrategy.distributeFairQueuesFromParentQueue(
          masterQueue,
          consumerId
        );

        span.setAttribute("environment_count", envQueues.length);

        if (envQueues.length === 0) {
          return [];
        }

        let attemptedEnvs = 0;
        let attemptedQueues = 0;

        const messages: DequeuedMessage[] = [];

        for (const env of envQueues) {
          attemptedEnvs++;

          for (const queue of env.queues) {
            attemptedQueues++;

            // Attempt to dequeue from this queue
            const [error, message] = await tryCatch(
              this.#callDequeueMessage({
                messageQueue: queue,
              })
            );

            if (error) {
              this.logger.error(
                `[dequeueMessageInSharedQueue][${this.name}] Failed to dequeue from queue ${queue}`,
                {
                  error,
                }
              );
            }

            if (message) {
              messages.push(message);
            }

            // If we've reached maxCount, we don't want to look at this env anymore
            if (messages.length >= maxCount) {
              break;
            }
          }

          // If we've reached maxCount, we're completely done
          if (messages.length >= maxCount) {
            break;
          }
        }

        span.setAttributes({
          [SemanticAttributes.RESULT_COUNT]: messages.length,
          [SemanticAttributes.MASTER_QUEUES]: masterQueue,
          attempted_environments: attemptedEnvs,
          attempted_queues: attemptedQueues,
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

        await this.#callAcknowledgeMessage({
          message,
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
          [SemanticAttributes.MASTER_QUEUES]: message.masterQueues.join(","),
        });

        if (incrementAttemptCount) {
          message.attempt = message.attempt + 1;
          if (message.attempt >= maxAttempts) {
            await this.#callMoveToDeadLetterQueue({ message });
            return false;
          }
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
          this.keys.currentConcurrencyKeyFromQueue(message.queue),
          this.keys.envCurrentConcurrencyKeyFromQueue(message.queue),
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

  public async releaseEnvConcurrency(orgId: string, messageId: string) {
    return this.#trace(
      "releaseEnvConcurrency",
      async (span) => {
        const message = await this.readMessage(orgId, messageId);

        if (!message) {
          this.logger.log(`[${this.name}].releaseEnvConcurrency() message not found`, {
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

        return this.redis.releaseEnvConcurrency(
          this.keys.envCurrentConcurrencyKeyFromQueue(message.queue),
          messageId
        );
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "releaseEnvConcurrency",
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
        const message = await this.readMessage(orgId, messageId);

        if (!message) {
          throw new MessageNotFoundError(messageId);
        }

        span.setAttributes({
          [SemanticAttributes.QUEUE]: message.queue,
          [SemanticAttributes.ORG_ID]: message.orgId,
          [SemanticAttributes.RUN_ID]: messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
        });

        const queueCurrentConcurrencyKey = this.keys.currentConcurrencyKeyFromQueue(message.queue);
        const envCurrentConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
        const queueConcurrencyLimitKey = this.keys.concurrencyLimitKeyFromQueue(message.queue);
        const envConcurrencyLimitKey = this.keys.envConcurrencyLimitKeyFromQueue(message.queue);

        const result = await this.redis.reacquireConcurrency(
          queueCurrentConcurrencyKey,
          envCurrentConcurrencyKey,
          queueConcurrencyLimitKey,
          envConcurrencyLimitKey,
          messageId,
          String(this.options.defaultEnvConcurrency)
        );

        return !!result;
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

  public async removeEnvironmentQueuesFromMasterQueue(
    masterQueue: string,
    organizationId: string,
    projectId: string
  ) {
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
    await this.subscriber.unsubscribe();
    await this.subscriber.quit();
    await this.redis.quit();
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

  async #callEnqueueMessage(message: OutputPayload, masterQueues: string[]) {
    const queueKey = message.queue;
    const messageKey = this.keys.messageKey(message.orgId, message.runId);
    const queueCurrentConcurrencyKey = this.keys.currentConcurrencyKeyFromQueue(message.queue);
    const envCurrentConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
    const envQueueKey = this.keys.envQueueKeyFromQueue(message.queue);

    const queueName = message.queue;
    const messageId = message.runId;
    const messageData = JSON.stringify(message);
    const messageScore = String(message.timestamp);
    const $masterQueues = JSON.stringify(masterQueues);
    const keyPrefix = this.options.redis.keyPrefix ?? "";

    this.logger.debug("Calling enqueueMessage", {
      queueKey,
      messageKey,
      queueCurrentConcurrencyKey,
      envCurrentConcurrencyKey,
      envQueueKey,
      queueName,
      messageId,
      messageData,
      messageScore,
      masterQueues: $masterQueues,
      service: this.name,
    });

    await this.redis.enqueueMessage(
      queueKey,
      messageKey,
      queueCurrentConcurrencyKey,
      envCurrentConcurrencyKey,
      envQueueKey,
      queueName,
      messageId,
      messageData,
      messageScore,
      $masterQueues,
      keyPrefix
    );
  }

  async #callDequeueMessage({
    messageQueue,
  }: {
    messageQueue: string;
  }): Promise<DequeuedMessage | undefined> {
    const queueConcurrencyLimitKey = this.keys.concurrencyLimitKeyFromQueue(messageQueue);
    const queueCurrentConcurrencyKey = this.keys.currentConcurrencyKeyFromQueue(messageQueue);
    const envConcurrencyLimitKey = this.keys.envConcurrencyLimitKeyFromQueue(messageQueue);
    const envCurrentConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(messageQueue);
    const messageKeyPrefix = this.keys.messageKeyPrefixFromQueue(messageQueue);
    const envQueueKey = this.keys.envQueueKeyFromQueue(messageQueue);

    this.logger.debug("#callDequeueMessage", {
      messageQueue,
      queueConcurrencyLimitKey,
      envConcurrencyLimitKey,
      queueCurrentConcurrencyKey,
      envCurrentConcurrencyKey,
      messageKeyPrefix,
      envQueueKey,
    });

    const result = await this.redis.dequeueMessage(
      //keys
      messageQueue,
      queueConcurrencyLimitKey,
      envConcurrencyLimitKey,
      queueCurrentConcurrencyKey,
      envCurrentConcurrencyKey,
      messageKeyPrefix,
      envQueueKey,
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

  async #callAcknowledgeMessage({ message }: { message: OutputPayload }) {
    const messageId = message.runId;
    const messageKey = this.keys.messageKey(message.orgId, messageId);
    const messageQueue = message.queue;
    const queueCurrentConcurrencyKey = this.keys.currentConcurrencyKeyFromQueue(message.queue);
    const envCurrentConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
    const envQueueKey = this.keys.envQueueKeyFromQueue(message.queue);
    const masterQueues = message.masterQueues;

    this.logger.debug("Calling acknowledgeMessage", {
      messageKey,
      messageQueue,
      queueCurrentConcurrencyKey,
      envCurrentConcurrencyKey,
      envQueueKey,
      messageId,
      masterQueues,
      service: this.name,
    });

    return this.redis.acknowledgeMessage(
      messageKey,
      messageQueue,
      queueCurrentConcurrencyKey,
      envCurrentConcurrencyKey,
      envQueueKey,
      messageId,
      messageQueue,
      JSON.stringify(masterQueues),
      this.options.redis.keyPrefix ?? ""
    );
  }

  async #callNackMessage({ message, retryAt }: { message: OutputPayload; retryAt?: number }) {
    const messageId = message.runId;
    const messageKey = this.keys.messageKey(message.orgId, message.runId);
    const messageQueue = message.queue;
    const queueCurrentConcurrencyKey = this.keys.currentConcurrencyKeyFromQueue(message.queue);
    const envCurrentConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
    const envQueueKey = this.keys.envQueueKeyFromQueue(message.queue);

    const nextRetryDelay = calculateNextRetryDelay(this.retryOptions, message.attempt);
    const messageScore = retryAt ?? (nextRetryDelay ? Date.now() + nextRetryDelay : Date.now());

    this.logger.debug("Calling nackMessage", {
      messageKey,
      messageQueue,
      masterQueues: message.masterQueues,
      queueCurrentConcurrencyKey,
      envCurrentConcurrencyKey,
      envQueueKey,
      messageId,
      messageScore,
      attempt: message.attempt,
      service: this.name,
    });

    await this.redis.nackMessage(
      //keys
      messageKey,
      messageQueue,
      queueCurrentConcurrencyKey,
      envCurrentConcurrencyKey,
      envQueueKey,
      //args
      messageId,
      messageQueue,
      JSON.stringify(message),
      String(messageScore),
      JSON.stringify(message.masterQueues),
      this.options.redis.keyPrefix ?? ""
    );
  }

  async #callMoveToDeadLetterQueue({ message }: { message: OutputPayload }) {
    const messageId = message.runId;
    const messageKey = this.keys.messageKey(message.orgId, message.runId);
    const messageQueue = message.queue;
    const queueCurrentConcurrencyKey = this.keys.currentConcurrencyKeyFromQueue(message.queue);
    const envCurrentConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
    const envQueueKey = this.keys.envQueueKeyFromQueue(message.queue);
    const deadLetterQueueKey = this.keys.deadLetterQueueKeyFromQueue(message.queue);

    await this.redis.moveToDeadLetterQueue(
      messageKey,
      messageQueue,
      queueCurrentConcurrencyKey,
      envCurrentConcurrencyKey,
      envQueueKey,
      deadLetterQueueKey,
      messageId,
      messageQueue,
      JSON.stringify(message.masterQueues),
      this.options.redis.keyPrefix ?? ""
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

  #registerCommands() {
    this.redis.defineCommand("enqueueMessage", {
      numberOfKeys: 5,
      lua: `
local queueKey = KEYS[1]
local messageKey = KEYS[2]
local queueCurrentConcurrencyKey = KEYS[3]
local envCurrentConcurrencyKey = KEYS[4]
local envQueueKey = KEYS[5]

local queueName = ARGV[1]
local messageId = ARGV[2]
local messageData = ARGV[3]
local messageScore = ARGV[4]
local parentQueues = cjson.decode(ARGV[5])
local keyPrefix = ARGV[6]

-- Write the message to the message key
redis.call('SET', messageKey, messageData)

-- Add the message to the queue
redis.call('ZADD', queueKey, messageScore, messageId)

-- Add the message to the env queue
redis.call('ZADD', envQueueKey, messageScore, messageId)

-- Rebalance the parent queues
local earliestMessage = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')

for _, parentQueue in ipairs(parentQueues) do
    local prefixedParentQueue = keyPrefix .. parentQueue
    if #earliestMessage == 0 then
        redis.call('ZREM', prefixedParentQueue, queueName)
    else
        redis.call('ZADD', prefixedParentQueue, earliestMessage[2], queueName)
    end
end

-- Update the concurrency keys
redis.call('SREM', queueCurrentConcurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
      `,
    });

    this.redis.defineCommand("dequeueMessage", {
      numberOfKeys: 7,
      lua: `
local queueKey = KEYS[1]
local queueConcurrencyLimitKey = KEYS[2]
local envConcurrencyLimitKey = KEYS[3]
local queueCurrentConcurrencyKey = KEYS[4]
local envCurrentConcurrencyKey = KEYS[5]
local messageKeyPrefix = KEYS[6]
local envQueueKey = KEYS[7]

local queueName = ARGV[1]
local currentTime = tonumber(ARGV[2])
local defaultEnvConcurrencyLimit = ARGV[3]
local keyPrefix = ARGV[4]

-- Check current env concurrency against the limit
local envCurrentConcurrency = tonumber(redis.call('SCARD', envCurrentConcurrencyKey) or '0')
local envConcurrencyLimit = tonumber(redis.call('GET', envConcurrencyLimitKey) or defaultEnvConcurrencyLimit)
local totalEnvConcurrencyLimit = envConcurrencyLimit

if envCurrentConcurrency >= totalEnvConcurrencyLimit then
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

-- Attempt to dequeue the next message
local messages = redis.call('ZRANGEBYSCORE', queueKey, '-inf', currentTime, 'WITHSCORES', 'LIMIT', 0, 1)

if #messages == 0 then
    return nil
end

local messageId = messages[1]
local messageScore = tonumber(messages[2])

-- Get the message payload
local messageKey = messageKeyPrefix .. messageId
local messagePayload = redis.call('GET', messageKey)
local decodedPayload = cjson.decode(messagePayload);

-- Update concurrency
redis.call('ZREM', queueKey, messageId)
redis.call('ZREM', envQueueKey, messageId)
redis.call('SADD', queueCurrentConcurrencyKey, messageId)
redis.call('SADD', envCurrentConcurrencyKey, messageId)

-- Rebalance the parent queues
local earliestMessage = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
for _, parentQueue in ipairs(decodedPayload.masterQueues) do
    local prefixedParentQueue = keyPrefix .. parentQueue
    if #earliestMessage == 0 then
        redis.call('ZREM', prefixedParentQueue, queueName)
    else
        redis.call('ZADD', prefixedParentQueue, earliestMessage[2], queueName)
    end
end

return {messageId, messageScore, messagePayload} -- Return message details
      `,
    });

    this.redis.defineCommand("acknowledgeMessage", {
      numberOfKeys: 5,
      lua: `
-- Keys:
local messageKey = KEYS[1]
local messageQueueKey = KEYS[2]
local queueCurrentConcurrencyKey = KEYS[3]
local envCurrentConcurrencyKey = KEYS[4]
local envQueueKey = KEYS[5]

-- Args:
local messageId = ARGV[1]
local messageQueueName = ARGV[2]
local parentQueues = cjson.decode(ARGV[3])
local keyPrefix = ARGV[4]

-- Remove the message from the message key
redis.call('DEL', messageKey)

-- Remove the message from the queue
redis.call('ZREM', messageQueueKey, messageId)
redis.call('ZREM', envQueueKey, messageId)

-- Rebalance the parent queues
local earliestMessage = redis.call('ZRANGE', messageQueueKey, 0, 0, 'WITHSCORES')
for _, parentQueue in ipairs(parentQueues) do
  local prefixedParentQueue = keyPrefix .. parentQueue
    if #earliestMessage == 0 then
        redis.call('ZREM', prefixedParentQueue, messageQueueName)
    else
        redis.call('ZADD', prefixedParentQueue, earliestMessage[2], messageQueueName)
    end
end

-- Update the concurrency keys
redis.call('SREM', queueCurrentConcurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
`,
    });

    this.redis.defineCommand("nackMessage", {
      numberOfKeys: 5,
      lua: `
-- Keys:
local messageKey = KEYS[1]
local messageQueueKey = KEYS[2]
local queueCurrentConcurrencyKey = KEYS[3]
local envCurrentConcurrencyKey = KEYS[4]
local envQueueKey = KEYS[5]

-- Args:
local messageId = ARGV[1]
local messageQueueName = ARGV[2]
local messageData = ARGV[3]
local messageScore = tonumber(ARGV[4])
local parentQueues = cjson.decode(ARGV[5])
local keyPrefix = ARGV[6]

-- Update the message data
redis.call('SET', messageKey, messageData)

-- Update the concurrency keys
redis.call('SREM', queueCurrentConcurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)

-- Enqueue the message into the queue
redis.call('ZADD', messageQueueKey, messageScore, messageId)
redis.call('ZADD', envQueueKey, messageScore, messageId)

-- Rebalance the parent queues
local earliestMessage = redis.call('ZRANGE', messageQueueKey, 0, 0, 'WITHSCORES')
for _, parentQueue in ipairs(parentQueues) do
    local prefixedParentQueue = keyPrefix .. parentQueue
    if #earliestMessage == 0 then
        redis.call('ZREM', prefixedParentQueue, messageQueueName)
    else
        redis.call('ZADD', prefixedParentQueue, earliestMessage[2], messageQueueName)
    end
end
`,
    });

    this.redis.defineCommand("moveToDeadLetterQueue", {
      numberOfKeys: 6,
      lua: `
-- Keys:
local messageKey = KEYS[1]
local messageQueue = KEYS[2]
local queueCurrentConcurrencyKey = KEYS[3]
local envCurrentConcurrencyKey = KEYS[4]
local envQueueKey = KEYS[5]
local deadLetterQueueKey = KEYS[6]

-- Args:
local messageId = ARGV[1]
local messageQueueName = ARGV[2]
local parentQueues = cjson.decode(ARGV[3])
local keyPrefix = ARGV[4]

-- Remove the message from the queue
redis.call('ZREM', messageQueue, messageId)
redis.call('ZREM', envQueueKey, messageId)

-- Rebalance the parent queues
local earliestMessage = redis.call('ZRANGE', messageQueue, 0, 0, 'WITHSCORES')
for _, parentQueue in ipairs(parentQueues) do
    local prefixedParentQueue = keyPrefix .. parentQueue
    if #earliestMessage == 0 then
        redis.call('ZREM', prefixedParentQueue, messageQueueName)
    else
        redis.call('ZADD', prefixedParentQueue, earliestMessage[2], messageQueueName)
    end
end

-- Add the message to the dead letter queue
redis.call('ZADD', deadLetterQueueKey, tonumber(redis.call('TIME')[1]), messageId)

-- Update the concurrency keys
redis.call('SREM', queueCurrentConcurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
`,
    });

    this.redis.defineCommand("releaseConcurrency", {
      numberOfKeys: 2,
      lua: `
-- Keys:
local queueCurrentConcurrencyKey = KEYS[1]
local envCurrentConcurrencyKey = KEYS[2]

-- Args:
local messageId = ARGV[1]

-- Update the concurrency keys
redis.call('SREM', queueCurrentConcurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
`,
    });

    this.redis.defineCommand("releaseEnvConcurrency", {
      numberOfKeys: 1,
      lua: `
-- Keys:
local envCurrentConcurrencyKey = KEYS[1]

-- Args:
local messageId = ARGV[1]

-- Update the concurrency keys
redis.call('SREM', envCurrentConcurrencyKey, messageId)
`,
    });

    this.redis.defineCommand("reacquireConcurrency", {
      numberOfKeys: 4,
      lua: `
-- Keys:
local queueCurrentConcurrencyKey = KEYS[1]
local envCurrentConcurrencyKey = KEYS[2]
local queueConcurrencyLimitKey = KEYS[3]
local envConcurrencyLimitKey = KEYS[4]

-- Args:
local messageId = ARGV[1]
local defaultEnvConcurrencyLimit = ARGV[2]

-- Check if the message is already in either current concurrency set
local isInQueueConcurrency = redis.call('SISMEMBER', queueCurrentConcurrencyKey, messageId) == 1
local isInEnvConcurrency = redis.call('SISMEMBER', envCurrentConcurrencyKey, messageId) == 1

-- If it's already in both sets, we're done
if isInQueueConcurrency and isInEnvConcurrency then
    return true
end

-- Check current env concurrency against the limit
local envCurrentConcurrency = tonumber(redis.call('SCARD', envCurrentConcurrencyKey) or '0')
local envConcurrencyLimit = tonumber(redis.call('GET', envConcurrencyLimitKey) or defaultEnvConcurrencyLimit)
local totalEnvConcurrencyLimit = envConcurrencyLimit

if envCurrentConcurrency >= totalEnvConcurrencyLimit then
    return false
end

-- Check current queue concurrency against the limit
if not isInQueueConcurrency then
    local queueCurrentConcurrency = tonumber(redis.call('SCARD', queueCurrentConcurrencyKey) or '0')
    local queueConcurrencyLimit = math.min(tonumber(redis.call('GET', queueConcurrencyLimitKey) or '1000000'), envConcurrencyLimit)
    local totalQueueConcurrencyLimit = queueConcurrencyLimit

    if queueCurrentConcurrency >= totalQueueConcurrencyLimit then
        return false
    end
end

-- Update the concurrency keys
redis.call('SADD', queueCurrentConcurrencyKey, messageId)
redis.call('SADD', envCurrentConcurrencyKey, messageId)

return true
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

declare module "@internal/redis" {
  interface RedisCommander<Context> {
    enqueueMessage(
      //keys
      queue: string,
      messageKey: string,
      queueCurrentConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
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
      queueConcurrencyLimitKey: string,
      envConcurrencyLimitKey: string,
      queueCurrentConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      messageKeyPrefix: string,
      envQueueKey: string,
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
      envQueueKey: string,
      messageId: string,
      messageQueueName: string,
      masterQueues: string,
      keyPrefix: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    nackMessage(
      messageKey: string,
      messageQueue: string,
      queueCurrentConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      envQueueKey: string,
      messageId: string,
      messageQueueName: string,
      messageData: string,
      messageScore: string,
      masterQueues: string,
      keyPrefix: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    moveToDeadLetterQueue(
      messageKey: string,
      messageQueue: string,
      queueCurrentConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      envQueueKey: string,
      deadLetterQueueKey: string,
      messageId: string,
      messageQueueName: string,
      masterQueues: string,
      keyPrefix: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    releaseConcurrency(
      queueCurrentConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      messageId: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    releaseEnvConcurrency(
      envCurrentConcurrencyKey: string,
      messageId: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    reacquireConcurrency(
      queueCurrentConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      queueConcurrencyLimitKey: string,
      envConcurrencyLimitKey: string,
      messageId: string,
      defaultEnvConcurrencyLimit: string,
      callback?: Callback<string>
    ): Result<string, Context>;

    updateGlobalConcurrencyLimits(
      envConcurrencyLimitKey: string,
      envConcurrencyLimit: string,
      callback?: Callback<void>
    ): Result<void, Context>;
  }
}
