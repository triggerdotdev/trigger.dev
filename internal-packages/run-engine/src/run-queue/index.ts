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
import {
  attributesFromAuthenticatedEnv,
  MinimalAuthenticatedEnvironment,
} from "../shared/index.js";
import {
  InputPayload,
  OutputPayload,
  QueueCapacities,
  QueueRange,
  RunQueueKeyProducer,
  RunQueuePriorityStrategy,
} from "./types.js";
import { RunQueueShortKeyProducer } from "./keyProducer.js";

const SemanticAttributes = {
  QUEUE: "runqueue.queue",
  MASTER_QUEUE: "runqueue.masterQueue",
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

    this.keys = new RunQueueShortKeyProducer("rq:");
    this.queuePriorityStrategy = options.queuePriorityStrategy;

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
    masterQueue,
  }: {
    env: MinimalAuthenticatedEnvironment;
    message: InputPayload;
    masterQueue: string;
  }) {
    return await this.#trace(
      "enqueueMessage",
      async (span) => {
        const { runId, concurrencyKey } = message;

        const queue = this.keys.queueKey(env, message.queue, concurrencyKey);

        propagation.inject(context.active(), message);

        span.setAttributes({
          [SemanticAttributes.QUEUE]: queue,
          [SemanticAttributes.RUN_ID]: runId,
          [SemanticAttributes.CONCURRENCY_KEY]: concurrencyKey,
          [SemanticAttributes.MASTER_QUEUE]: masterQueue,
        });

        const messagePayload: OutputPayload = {
          ...message,
          version: "1",
          queue,
          masterQueue,
        };

        await this.#callEnqueueMessage(messagePayload, masterQueue);
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

  public async getSharedQueueDetails(masterQueue: string) {
    const { range } = await this.queuePriorityStrategy.nextCandidateSelection(
      masterQueue,
      "getSharedQueueDetails"
    );
    const queues = await this.#getChildQueuesWithScores(masterQueue, range);

    const queuesWithScores = await this.#calculateQueueScores(queues, (queue) =>
      this.#calculateMessageQueueCapacities(queue)
    );

    // We need to priority shuffle here to ensure all workers aren't just working on the highest priority queue
    const choice = this.queuePriorityStrategy.chooseQueue(
      queuesWithScores,
      masterQueue,
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
  public async dequeueMessageInSharedQueue(consumerId: string, masterQueue: string) {
    return this.#trace(
      "dequeueMessageInSharedQueue",
      async (span) => {
        // Read the parent queue for matching queues
        const messageQueue = await this.#getRandomQueueFromParentQueue(
          masterQueue,
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
          masterQueue,
          concurrencyLimitKey: this.keys.concurrencyLimitKeyFromQueue(messageQueue),
          currentConcurrencyKey: this.keys.currentConcurrencyKeyFromQueue(messageQueue),
          envConcurrencyLimitKey: this.keys.envConcurrencyLimitKeyFromQueue(messageQueue),
          envCurrentConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(messageQueue),
          projectCurrentConcurrencyKey:
            this.keys.projectCurrentConcurrencyKeyFromQueue(messageQueue),
          messageKeyPrefix: this.keys.messageKeyPrefixFromQueue(messageQueue),
          taskCurrentConcurrentKeyPrefix:
            this.keys.taskIdentifierCurrentConcurrencyKeyPrefixFromQueue(messageQueue),
        });

        if (!message) {
          return;
        }

        span.setAttributes({
          [SEMATTRS_MESSAGE_ID]: message.messageId,
          [SemanticAttributes.QUEUE]: message.message.queue,
          [SemanticAttributes.RUN_ID]: message.message.runId,
          [SemanticAttributes.CONCURRENCY_KEY]: message.message.concurrencyKey,
          [SemanticAttributes.MASTER_QUEUE]: masterQueue,
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
          masterQueue: message.masterQueue,
          messageKey: this.keys.messageKey(orgId, messageId),
          concurrencyKey: this.keys.currentConcurrencyKeyFromQueue(message.queue),
          envConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(message.queue),
          taskConcurrencyKey: this.keys.taskIdentifierCurrentConcurrencyKeyFromQueue(
            message.queue,
            message.taskIdentifier
          ),
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
   * Negative acknowledge a message, which will requeue the message (with an optional future date)
   */
  public async nackMessage(orgId: string, messageId: string, retryAt: number = Date.now()) {
    return this.#trace(
      "nackMessage",
      async (span) => {
        const message = await this.#readMessage(orgId, messageId);
        if (!message) {
          this.logger.log(`[${this.name}].nackMessage() message not found`, {
            orgId,
            messageId,
            retryAt,
            service: this.name,
          });
          return;
        }

        span.setAttributes({
          [SemanticAttributes.QUEUE]: message.queue,
          [SemanticAttributes.RUN_ID]: messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
          [SemanticAttributes.MASTER_QUEUE]: message.masterQueue,
        });

        const messageKey = this.keys.messageKey(orgId, messageId);
        const messageQueue = message.queue;
        const parentQueue = message.masterQueue;
        const concurrencyKey = this.keys.currentConcurrencyKeyFromQueue(message.queue);
        const envConcurrencyKey = this.keys.envCurrentConcurrencyKeyFromQueue(message.queue);
        const taskConcurrencyKey = this.keys.taskIdentifierCurrentConcurrencyKeyFromQueue(
          message.queue,
          message.taskIdentifier
        );
        const projectConcurrencyKey = this.keys.projectCurrentConcurrencyKeyFromQueue(
          message.queue
        );

        const messageScore = retryAt;

        this.logger.debug("Calling nackMessage", {
          messageKey,
          messageQueue,
          parentQueue,
          concurrencyKey,
          envConcurrencyKey,
          projectConcurrencyKey,
          taskConcurrencyKey,
          messageId,
          messageScore,
          service: this.name,
        });

        await this.redis.nackMessage(
          //keys
          messageKey,
          messageQueue,
          parentQueue,
          concurrencyKey,
          envConcurrencyKey,
          projectConcurrencyKey,
          taskConcurrencyKey,
          //args
          messageId,
          String(messageScore)
        );
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
    await Promise.all(this.#rebalanceWorkers.map((worker) => worker.stop()));
    await this.redis.quit();
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
          [SemanticAttributes.MASTER_QUEUE]: parentQueue,
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

  async #callEnqueueMessage(message: OutputPayload, parentQueue: string) {
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
      service: this.name,
    });

    return this.redis.enqueueMessage(
      message.queue,
      parentQueue,
      this.keys.messageKey(message.orgId, message.runId),
      concurrencyKey,
      envConcurrencyKey,
      taskConcurrencyKey,
      projectConcurrencyKey,
      message.queue,
      message.runId,
      JSON.stringify(message),
      String(message.timestamp)
    );
  }

  async #callDequeueMessage({
    messageQueue,
    masterQueue,
    concurrencyLimitKey,
    envConcurrencyLimitKey,
    currentConcurrencyKey,
    envCurrentConcurrencyKey,
    projectCurrentConcurrencyKey,
    messageKeyPrefix,
    taskCurrentConcurrentKeyPrefix,
  }: {
    messageQueue: string;
    masterQueue: string;
    concurrencyLimitKey: string;
    envConcurrencyLimitKey: string;
    currentConcurrencyKey: string;
    envCurrentConcurrencyKey: string;
    projectCurrentConcurrencyKey: string;
    messageKeyPrefix: string;
    taskCurrentConcurrentKeyPrefix: string;
  }) {
    const result = await this.redis.dequeueMessage(
      //keys
      messageQueue,
      masterQueue,
      concurrencyLimitKey,
      envConcurrencyLimitKey,
      currentConcurrencyKey,
      envCurrentConcurrencyKey,
      projectCurrentConcurrencyKey,
      messageKeyPrefix,
      taskCurrentConcurrentKeyPrefix,
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
    masterQueue,
    messageKey,
    messageQueue,
    concurrencyKey,
    envConcurrencyKey,
    taskConcurrencyKey,
    projectConcurrencyKey,
  }: {
    masterQueue: string;
    messageKey: string;
    messageQueue: string;
    concurrencyKey: string;
    envConcurrencyKey: string;
    taskConcurrencyKey: string;
    projectConcurrencyKey: string;
    messageId: string;
  }) {
    this.logger.debug("Calling acknowledgeMessage", {
      messageKey,
      messageQueue,
      concurrencyKey,
      envConcurrencyKey,
      projectConcurrencyKey,
      taskConcurrencyKey,
      messageId,
      masterQueue,
      service: this.name,
    });

    return this.redis.acknowledgeMessage(
      masterQueue,
      messageKey,
      messageQueue,
      concurrencyKey,
      envConcurrencyKey,
      projectConcurrencyKey,
      taskConcurrencyKey,
      messageId
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
local envConcurrencyKey = KEYS[5]
local taskConcurrencyKey = KEYS[6]
local projectConcurrencyKey = KEYS[7]

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
redis.call('SREM', envConcurrencyKey, messageId)
redis.call('SREM', taskConcurrencyKey, messageId)
redis.call('SREM', projectConcurrencyKey, messageId)
      `,
    });

    this.redis.defineCommand("dequeueMessage", {
      numberOfKeys: 9,
      lua: `
local childQueue = KEYS[1]
local parentQueue = KEYS[2]
local concurrencyLimitKey = KEYS[3]
local envConcurrencyLimitKey = KEYS[4]
local currentConcurrencyKey = KEYS[5]
local envCurrentConcurrencyKey = KEYS[6]
local projectConcurrencyKey = KEYS[7]
local messageKeyPrefix = KEYS[8]
local taskCurrentConcurrentKeyPrefix = KEYS[9]

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

-- Get the message payload
local messageKey = messageKeyPrefix .. messageId
local messagePayload = redis.call('GET', messageKey)

-- Parse JSON payload and extract taskIdentifier
local taskIdentifier = cjson.decode(messagePayload).taskIdentifier

-- Perform SADD with taskIdentifier and messageId
local taskConcurrencyKey = taskCurrentConcurrentKeyPrefix .. taskIdentifier

-- Update concurrency
redis.call('ZREM', childQueue, messageId)
redis.call('SADD', currentConcurrencyKey, messageId)
redis.call('SADD', envCurrentConcurrencyKey, messageId)
redis.call('SADD', projectConcurrencyKey, messageId)
redis.call('SADD', taskConcurrencyKey, messageId)

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', childQueue, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueue, childQueueName)
else
    redis.call('ZADD', parentQueue, earliestMessage[2], childQueueName)
end

return {messageId, messageScore, messagePayload} -- Return message details
      `,
    });

    this.redis.defineCommand("acknowledgeMessage", {
      numberOfKeys: 7,
      lua: `
-- Keys: 
local parentQueue = KEYS[1]
local messageKey = KEYS[2]
local messageQueue = KEYS[3]
local concurrencyKey = KEYS[4]
local envCurrentConcurrencyKey = KEYS[5]
local projectCurrentConcurrencyKey = KEYS[6]
local taskCurrentConcurrencyKey = KEYS[7]

-- Args:
local messageId = ARGV[1]

-- Remove the message from the message key
redis.call('DEL', messageKey)

-- Remove the message from the queue
redis.call('ZREM', messageQueue, messageId)

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', messageQueue, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueue, messageQueue)
else
    redis.call('ZADD', parentQueue, earliestMessage[2], messageQueue)
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
local parentQueueKey = KEYS[3]
local concurrencyKey = KEYS[4]
local envConcurrencyKey = KEYS[5]
local projectConcurrencyKey = KEYS[6]
local taskConcurrencyKey = KEYS[7]

-- Args: 
local messageId = ARGV[1]
local messageScore = tonumber(ARGV[2])

-- Update the concurrency keys
redis.call('SREM', concurrencyKey, messageId)
redis.call('SREM', envConcurrencyKey, messageId)
redis.call('SREM', projectConcurrencyKey, messageId)
redis.call('SREM', taskConcurrencyKey, messageId)

-- Enqueue the message into the queue
redis.call('ZADD', messageQueueKey, messageScore, messageId)

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', messageQueueKey, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueueKey, messageQueueKey)
else
    redis.call('ZADD', parentQueueKey, earliestMessage[2], messageQueueKey)
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
      taskConcurrencyKey: string,
      projectConcurrencyKey: string,
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
      envConcurrencyKey: string,
      projectConcurrencyKey: string,
      messageKeyPrefix: string,
      taskCurrentConcurrentKeyPrefix: string,
      //args
      childQueueName: string,
      currentTime: string,
      defaultEnvConcurrencyLimit: string,
      callback?: Callback<[string, string]>
    ): Result<[string, string, string] | null, Context>;

    acknowledgeMessage(
      parentQueue: string,
      messageKey: string,
      messageQueue: string,
      concurrencyKey: string,
      envConcurrencyKey: string,
      projectConcurrencyKey: string,
      taskConcurrencyKey: string,
      messageId: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    nackMessage(
      messageKey: string,
      messageQueue: string,
      parentQueueKey: string,
      concurrencyKey: string,
      envConcurrencyKey: string,
      projectConcurrencyKey: string,
      taskConcurrencyKey: string,
      messageId: string,
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
