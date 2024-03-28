import Redis, { type Callback, type RedisOptions, type Result } from "ioredis";
import { z } from "zod";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { singleton } from "~/utils/singleton";
import { AsyncWorker } from "./marqs/asyncWorker.server";
import { logger } from "~/services/logger.server";
import { attributesFromAuthenticatedEnv } from "./tracer.server";
import { Span, SpanKind, SpanOptions, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("marqs");

const KEY_PREFIX = "marqs:";

type MarQSOptions = {
  redis: RedisOptions;
  defaultConcurrency?: number;
  windowSize?: number;
  visibilityTimeoutInMs?: number;
  workers: number;
};

const constants = {
  SHARED_QUEUE: "sharedQueue",
  MESSAGE_VISIBILITY_TIMEOUT_QUEUE: "msgVisibilityTimeout",
  CURRENT_CONCURRENCY_PART: "currentConcurrency",
  CONCURRENCY_LIMIT_PART: "concurrency",
  ENV_PART: "env",
  QUEUE_PART: "queue",
  CONCURRENCY_KEY_PART: "ck",
  MESSAGE_PART: "message",
} as const;

const MessagePayload = z.object({
  version: z.literal("1"),
  data: z.record(z.unknown()),
  queue: z.string(),
  messageId: z.string(),
  timestamp: z.number(),
  parentQueue: z.string(),
  concurrencyKey: z.string().optional(),
});

type MessagePayload = z.infer<typeof MessagePayload>;

const SemanticAttributes = {
  QUEUE: "marqs.queue",
  PARENT_QUEUE: "marqs.parentQueue",
  MESSAGE_ID: "marqs.messageId",
  CONCURRENCY_KEY: "marqs.concurrencyKey",
};

/**
 * MarQS - Multitenant Asynchronous Reliable Queueing System (pronounced "markus")
 */
export class MarQS {
  private redis: Redis;
  #requeueingWorkers: Array<AsyncWorker> = [];

  constructor(private readonly options: MarQSOptions) {
    this.redis = new Redis(options.redis);

    // Spawn options.workers workers to requeue visible messages
    this.#startRequeuingWorkers();

    this.#registerCommands();
  }

  public async updateQueueConcurrency(
    env: AuthenticatedEnvironment,
    queue: string,
    concurrency: number
  ) {
    return this.redis.set(
      `${constants.ENV_PART}:${env.id}:${constants.QUEUE_PART}:${queue}:${constants.CONCURRENCY_LIMIT_PART}`,
      concurrency
    );
  }

  public async enqueueMessage(
    env: AuthenticatedEnvironment,
    queue: string,
    messageId: string,
    messageData: Record<string, unknown>,
    concurrencyKey?: string
  ) {
    return await this.#trace(
      "enqueueMessage",
      async (span) => {
        const messageQueue = `${constants.ENV_PART}:${env.id}:${constants.QUEUE_PART}:${queue}${
          concurrencyKey ? `:${constants.CONCURRENCY_KEY_PART}:${concurrencyKey}` : ""
        }`;

        const timestamp = Date.now();

        const parentQueue =
          env.type === "DEVELOPMENT"
            ? `${constants.ENV_PART}:${env.id}:${constants.SHARED_QUEUE}`
            : constants.SHARED_QUEUE;

        const messagePayload: MessagePayload = {
          version: "1",
          data: messageData,
          queue: messageQueue,
          concurrencyKey,
          timestamp,
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
      { kind: SpanKind.PRODUCER, attributes: { ...attributesFromAuthenticatedEnv(env) } }
    );
  }

  public async dequeueMessageInEnv(env: AuthenticatedEnvironment) {
    return this.#trace(
      "dequeueMessageInEnv",
      async (span, abort) => {
        const parentQueue =
          env.type === "DEVELOPMENT"
            ? `${constants.ENV_PART}:${env.id}:${constants.SHARED_QUEUE}`
            : constants.SHARED_QUEUE;

        // Read the parent queue for matching queues
        const messageQueue = await this.#getRandomQueueFromParentQueue(
          parentQueue,
          (queue, score) => this.#calculateMessageQueueWeight(queue, score)
        );

        if (!messageQueue) {
          abort();
          return;
        }

        // If the queue includes a concurrency key, we need to remove the ck:concurrencyKey from the queue name
        const concurrencyQueueName = messageQueue.replace(/:ck:.+$/, "");

        const messageData = await this.#callDequeueMessage({
          messageQueue,
          parentQueue,
          visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
          concurrencyLimitKey: `${concurrencyQueueName}:${constants.CONCURRENCY_LIMIT_PART}`,
          currentConcurrencyKey: `${messageQueue}:${constants.CURRENT_CONCURRENCY_PART}`,
        });

        if (!messageData) {
          abort();
          return;
        }

        const message = await this.#readMessage(messageData.messageId);

        if (message) {
          span.setAttributes({
            [SemanticAttributes.QUEUE]: message.queue,
            [SemanticAttributes.MESSAGE_ID]: message.messageId,
            [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
            [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
          });
        } else {
          abort();
        }

        return message;
      },
      { kind: SpanKind.CONSUMER, attributes: { ...attributesFromAuthenticatedEnv(env) } }
    );
  }

  /**
   * Dequeue a message from the shared queue (this should be used in production environments)
   */
  public async dequeueMessageInSharedQueue() {
    return this.#trace(
      "dequeueMessageInSharedQueue",
      async (span, abort) => {
        const parentQueue = constants.SHARED_QUEUE;

        // Read the parent queue for matching queues
        const messageQueue = await this.#getRandomQueueFromParentQueue(
          parentQueue,
          (queue, score) => this.#calculateMessageQueueWeight(queue, score)
        );

        if (!messageQueue) {
          abort();
          return;
        }

        // If the queue includes a concurrency key, we need to remove the ck:concurrencyKey from the queue name
        const concurrencyQueueName = messageQueue.replace(/:ck:.+$/, "");

        const messageData = await this.#callDequeueMessage({
          messageQueue,
          parentQueue,
          visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
          concurrencyLimitKey: `${concurrencyQueueName}:${constants.CONCURRENCY_LIMIT_PART}`,
          currentConcurrencyKey: `${messageQueue}:${constants.CURRENT_CONCURRENCY_PART}`,
        });

        if (!messageData) {
          abort();
          return;
        }

        const message = await this.#readMessage(messageData.messageId);

        if (message) {
          span.setAttributes({
            [SemanticAttributes.QUEUE]: message.queue,
            [SemanticAttributes.MESSAGE_ID]: message.messageId,
            [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
            [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
          });
        } else {
          abort();
        }

        return message;
      },
      { kind: SpanKind.CONSUMER }
    );
  }

  public async acknowledgeMessage(messageId: string) {
    return this.#trace(
      "acknowledgeMessage",
      async (span) => {
        const message = await this.#readMessage(messageId);

        if (!message) {
          return;
        }

        span.setAttributes({
          [SemanticAttributes.QUEUE]: message.queue,
          [SemanticAttributes.MESSAGE_ID]: message.messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
          [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
        });

        await this.#callAcknowledgeMessage({
          messageKey: `${constants.MESSAGE_PART}:${messageId}`,
          visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
          concurrencyKey: `${message.queue}:${constants.CURRENT_CONCURRENCY_PART}`,
          messageId,
        });
      },
      { kind: SpanKind.CONSUMER }
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
        const oldMessage = await this.#readMessage(messageId);

        if (!oldMessage) {
          return;
        }

        span.setAttributes({
          [SemanticAttributes.QUEUE]: oldMessage.queue,
          [SemanticAttributes.MESSAGE_ID]: oldMessage.messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: oldMessage.concurrencyKey,
          [SemanticAttributes.PARENT_QUEUE]: oldMessage.parentQueue,
        });

        await this.#callAcknowledgeMessage({
          messageKey: `${constants.MESSAGE_PART}:${messageId}`,
          visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
          concurrencyKey: `${oldMessage.queue}:${constants.CURRENT_CONCURRENCY_PART}`,
          messageId,
        });

        const newMessage: MessagePayload = {
          version: "1",
          data: messageData,
          queue: oldMessage.queue,
          concurrencyKey: oldMessage.concurrencyKey,
          timestamp: timestamp ?? Date.now(),
          messageId,
          parentQueue: oldMessage.parentQueue,
        };

        await this.#callEnqueueMessage(newMessage);
      },
      { kind: SpanKind.CONSUMER }
    );
  }

  async #trace<T>(
    name: string,
    fn: (span: Span, abort: () => void) => Promise<T>,
    options?: SpanOptions
  ): Promise<T> {
    return tracer.startActiveSpan(name, options ?? {}, async (span) => {
      let _abort = false;
      let aborter = () => {
        _abort = true;
      };

      try {
        return await fn(span, aborter);
      } catch (e) {
        if (e instanceof Error) {
          span.recordException(e);
        } else {
          span.recordException(new Error(String(e)));
        }

        throw e;
      } finally {
        if (!_abort) {
          span.end();
        }
      }
    });
  }

  /**
   * Negative acknowledge a message, which will requeue the message
   */
  public async nackMessage(messageId: string, retryAt: number = Date.now()) {
    return this.#trace(
      "nackMessage",
      async (span) => {
        const message = await this.#readMessage(messageId);

        if (!message) {
          return;
        }

        span.setAttributes({
          [SemanticAttributes.QUEUE]: message.queue,
          [SemanticAttributes.MESSAGE_ID]: message.messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
          [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
        });

        await this.#callNackMessage({
          messageKey: `${constants.MESSAGE_PART}:${messageId}`,
          messageQueue: message.queue,
          parentQueue: message.parentQueue,
          concurrencyKey: `${message.queue}:${constants.CURRENT_CONCURRENCY_PART}`,
          visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
          messageId,
          messageScore: retryAt,
        });
      },
      { kind: SpanKind.CONSUMER }
    );
  }

  // This should increment by the number of seconds, but with a max value of Date.now() + visibilityTimeoutInMs
  public async heartbeatMessage(messageId: string, seconds: number = 30) {
    await this.#callHeartbeatMessage({
      visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
      messageId,
      milliseconds: seconds * 1000,
      maxVisibilityTimeout: Date.now() + this.visibilityTimeoutInMs,
    });
  }

  get visibilityTimeoutInMs() {
    return this.options.visibilityTimeoutInMs ?? 300000;
  }

  async #readMessage(messageId: string) {
    return this.#trace(
      "readMessage",
      async (span) => {
        const rawMessage = await this.redis.get(`${constants.MESSAGE_PART}:${messageId}`);

        if (!rawMessage) {
          return;
        }

        const message = MessagePayload.safeParse(JSON.parse(rawMessage));

        if (!message.success) {
          logger.error("Failed to parse message", {
            messageId,
            error: message.error,
          });

          return;
        }

        return message.data;
      },
      { attributes: { [SemanticAttributes.MESSAGE_ID]: messageId } }
    );
  }

  async #getRandomQueueFromParentQueue(
    parentQueue: string,
    calculateWeight: (queue: string, score: number) => Promise<number>
  ) {
    return this.#trace(
      "getRandomQueueFromParentQueue",
      async (span, abort) => {
        const queues = await this.#zrangeWithScores(parentQueue, 0, -1);

        if (queues.length === 0) {
          abort();
          return;
        }

        span.setAttribute("marqs.queueCount", queues.length);

        const queuesWithWeights = await this.#calculateQueueWeights(queues, calculateWeight);

        // We need to priority shuffle here to ensure all workers aren't just working on the highest priority queue
        return await this.#weightedRandomChoice(queuesWithWeights);
      },
      { kind: SpanKind.CONSUMER, attributes: { [SemanticAttributes.PARENT_QUEUE]: parentQueue } }
    );
  }

  // Calculate the weights of the queues based on the age and the capacity
  async #calculateQueueWeights(
    queues: Array<{ value: string; score: number }>,
    calculateWeight: (queue: string, score: number) => Promise<number>
  ) {
    const queueWeights = await Promise.all(
      queues.map(async (queue) => {
        return {
          queue: queue.value,
          weight: await calculateWeight(queue.value, queue.score),
        };
      })
    );

    return queueWeights;
  }

  async #calculateMessageQueueWeight(queue: string, score: number) {
    const concurrencyQueueName = queue.replace(/:ck:.+$/, "");

    const concurrencyLimit =
      (await this.redis.get(`${concurrencyQueueName}:${constants.CONCURRENCY_LIMIT_PART}`)) ?? 100;

    const guardedConcurrencyLimit = Math.max(Number(concurrencyLimit), 1); // Ensure we don't divide by 0

    const currentConcurrency = await this.redis.scard(
      `${queue}:${constants.CURRENT_CONCURRENCY_PART}`
    );

    const guardedCurrentConcurrency = Math.max(Number(currentConcurrency), 0);

    const capacity = Math.max(guardedConcurrencyLimit - guardedCurrentConcurrency, 0); // Ensure we don't have negative capacity

    const capacityWeight = capacity / guardedConcurrencyLimit;
    const ageWeight = Date.now() - score;

    return ageWeight * 0.8 + capacityWeight * 0.2;
  }

  async #weightedRandomChoice(queues: Array<{ queue: string; weight: number }>) {
    const totalWeight = queues.reduce((acc, queue) => acc + queue.weight, 0);
    const randomNum = Math.random() * totalWeight;
    let weightSum = 0;

    for (const queue of queues) {
      weightSum += queue.weight;
      if (randomNum <= weightSum) {
        return queue.queue;
      }
    }

    return queues[queues.length - 1].queue;
  }

  async #zrangeWithScores(
    key: string,
    min: number,
    max: number
  ): Promise<Array<{ value: string; score: number }>> {
    const valuesWithScores = await this.redis.zrange(key, min, max, "WITHSCORES");
    const result: Array<{ value: string; score: number }> = [];

    for (let i = 0; i < valuesWithScores.length; i += 2) {
      result.push({
        value: valuesWithScores[i],
        score: Number(valuesWithScores[i + 1]),
      });
    }

    return result;
  }

  #startRequeuingWorkers() {
    // Start a new worker to requeue visible messages
    for (let i = 0; i < this.options.workers; i++) {
      const worker = new AsyncWorker(this.#requeueVisibleMessages.bind(this), 1000);

      this.#requeueingWorkers.push(worker);

      worker.start();
    }
  }

  async #requeueVisibleMessages() {
    // Remove any of the messages from the timeoutQueue that have expired
    const messages = await this.redis.zrangebyscore(
      constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
      0,
      Date.now(),
      "LIMIT",
      0,
      10
    );

    if (messages.length === 0) {
      return;
    }

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];

      const messageData = await this.redis.get(`${constants.MESSAGE_PART}:${message}`);

      if (!messageData) {
        // The message has been removed for some reason (TTL, etc.), so we should remove it from the timeout queue
        await this.redis.zrem(constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE, message);

        continue;
      }

      const parsedMessage = MessagePayload.safeParse(JSON.parse(messageData));

      if (!parsedMessage.success) {
        await this.redis.zrem(constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE, message);

        continue;
      }

      await this.#callNackMessage({
        messageKey: `${constants.MESSAGE_PART}:${message}`,
        messageQueue: parsedMessage.data.queue,
        parentQueue: parsedMessage.data.parentQueue,
        concurrencyKey: `${parsedMessage.data.queue}:${constants.CURRENT_CONCURRENCY_PART}`,
        visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
        messageId: parsedMessage.data.messageId,
        messageScore: parsedMessage.data.timestamp,
      });
    }
  }

  async #callEnqueueMessage(message: MessagePayload) {
    logger.debug("Calling enqueueMessage", {
      messagePayload: message,
    });

    return this.redis.enqueueMessage(
      message.queue,
      message.parentQueue,
      `${constants.MESSAGE_PART}:${message.messageId}`,
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
    currentConcurrencyKey,
  }: {
    messageQueue: string;
    parentQueue: string;
    visibilityQueue: string;
    concurrencyLimitKey: string;
    currentConcurrencyKey: string;
  }) {
    const result = await this.redis.dequeueMessage(
      messageQueue,
      parentQueue,
      visibilityQueue,
      concurrencyLimitKey,
      currentConcurrencyKey,
      messageQueue,
      String(this.options.visibilityTimeoutInMs ?? 300000), // 5 minutes
      String(Date.now()),
      String(this.options.defaultConcurrency ?? 10)
    );

    if (!result) {
      return;
    }

    logger.debug("Dequeue message result", {
      result,
    });

    if (result.length !== 2) {
      return;
    }

    return {
      messageId: result[0],
      messageScore: result[1],
    };
  }

  async #callAcknowledgeMessage({
    messageKey,
    visibilityQueue,
    concurrencyKey,
    messageId,
  }: {
    messageKey: string;
    visibilityQueue: string;
    concurrencyKey: string;
    messageId: string;
  }) {
    logger.debug("Calling acknowledgeMessage", {
      messageKey,
      visibilityQueue,
      concurrencyKey,
      messageId,
    });

    return this.redis.acknowledgeMessage(messageKey, visibilityQueue, concurrencyKey, messageId);
  }

  async #callNackMessage({
    messageKey,
    messageQueue,
    parentQueue,
    concurrencyKey,
    visibilityQueue,
    messageId,
    messageScore,
  }: {
    messageKey: string;
    messageQueue: string;
    parentQueue: string;
    concurrencyKey: string;
    visibilityQueue: string;
    messageId: string;
    messageScore: number;
  }) {
    logger.debug("Calling nackMessage", {
      messageKey,
      messageQueue,
      parentQueue,
      concurrencyKey,
      visibilityQueue,
      messageId,
      messageScore,
    });

    return this.redis.nackMessage(
      messageKey,
      messageQueue,
      parentQueue,
      concurrencyKey,
      visibilityQueue,
      messageQueue,
      messageId,
      String(Date.now()),
      String(messageScore)
    );
  }

  #callHeartbeatMessage({
    visibilityQueue,
    messageId,
    milliseconds,
    maxVisibilityTimeout,
  }: {
    visibilityQueue: string;
    messageId: string;
    milliseconds: number;
    maxVisibilityTimeout: number;
  }) {
    return this.redis.heartbeatMessage(
      visibilityQueue,
      messageId,
      String(milliseconds),
      String(maxVisibilityTimeout)
    );
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
      numberOfKeys: 5,
      lua: `
-- Keys: childQueue, parentQueue, visibilityQueue, concurrencyLimitKey, currentConcurrencyKey
-- Args: visibilityTimeout, currentTime
local childQueue = KEYS[1]
local parentQueue = KEYS[2]
local visibilityQueue = KEYS[3]
local concurrencyLimitKey = KEYS[4]
local currentConcurrencyKey = KEYS[5]
local childQueueName = ARGV[1]
local visibilityTimeout = tonumber(ARGV[2])
local currentTime = tonumber(ARGV[3])
local defaultConcurrencyLimit = ARGV[4]

-- Check current concurrency against the limit
local currentConcurrency = tonumber(redis.call('SCARD', currentConcurrencyKey) or '0')
local concurrencyLimit = tonumber(redis.call('GET', concurrencyLimitKey) or defaultConcurrencyLimit)

if currentConcurrency < concurrencyLimit then
    -- Attempt to dequeue the next message
    local messages = redis.call('ZRANGEBYSCORE', childQueue, '-inf', currentTime, 'WITHSCORES', 'LIMIT', 0, 1)
    if #messages == 0 then
        return nil
    end
    local messageId = messages[1]
    local messageScore = tonumber(messages[2])
    local timeoutScore = currentTime + visibilityTimeout

    -- Move message to timeout queue and update concurrency
    redis.call('ZREM', childQueue, messageId)
    redis.call('ZADD', visibilityQueue, timeoutScore, messageId)
    redis.call('SADD', currentConcurrencyKey, messageId)

    -- Rebalance the parent queue
    local earliestMessage = redis.call('ZRANGE', childQueue, 0, 0, 'WITHSCORES')
    if #earliestMessage == 0 then
        redis.call('ZREM', parentQueue, childQueueName)
    else
        redis.call('ZADD', parentQueue, earliestMessage[2], childQueueName)
    end
    
    return {messageId, messageScore} -- Return message details
end

return nil

      `,
    });

    this.redis.defineCommand("acknowledgeMessage", {
      numberOfKeys: 3,
      lua: `
-- Keys: messageKey, visibilityQueue, concurrencyKey
local messageKey = KEYS[1]
local visibilityQueue = KEYS[2]
local concurrencyKey = KEYS[3]

-- Args: messageId
local messageId = ARGV[1]

-- Remove the message from the message key
redis.call('DEL', messageKey)

-- Remove the message from the timeout queue
redis.call('ZREM', visibilityQueue, messageId)

-- Update the concurrency key
redis.call('SREM', concurrencyKey, messageId)
`,
    });

    this.redis.defineCommand("nackMessage", {
      numberOfKeys: 5,
      lua: `
-- Keys: childQueueKey, parentQueueKey, visibilityQueue, concurrencyKey, messageId
local messageKey = KEYS[1]
local childQueueKey = KEYS[2]
local parentQueueKey = KEYS[3]
local concurrencyKey = KEYS[4]
local visibilityQueue = KEYS[5]

-- Args: childQueueName, messageId, currentTime, messageScore
local childQueueName = ARGV[1]
local messageId = ARGV[2]
local currentTime = tonumber(ARGV[3])
local messageScore = tonumber(ARGV[4])

-- Check to see if the message is still in the visibilityQueue
local messageVisibility = tonumber(redis.call('ZSCORE', visibilityQueue, messageId)) or 0

if messageVisibility == 0 then
    return
end

-- Update the concurrency key
redis.call('SREM', concurrencyKey, messageId)

-- Remove the message from the timeout queue
redis.call('ZREM', visibilityQueue, messageId)

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
local currentVisibilityTimeout = tonumber(redis.call('ZSCORE', visibilityQueue, messageId)) or 0

if currentVisibilityTimeout == 0 then
    return
end

-- Calculate the new visibility timeout
local newVisibilityTimeout = math.min(currentVisibilityTimeout + milliseconds * 1000, maxVisibilityTimeout)

-- Update the visibility timeout
redis.call('ZADD', visibilityQueue, newVisibilityTimeout, messageId)
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
      visibilityQueue: string,
      concurrencyLimitKey: string,
      currentConcurrencyKey: string,
      childQueueName: string,
      visibilityTimeout: string,
      currentTime: string,
      defaultConcurrencyLimit: string,
      callback?: Callback<[string, string]>
    ): Result<[string, string] | null, Context>;

    acknowledgeMessage(
      messageKey: string,
      visibilityQueue: string,
      concurrencyKey: string,
      messageId: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    nackMessage(
      messageKey: string,
      childQueueKey: string,
      parentQueueKey: string,
      concurrencyKey: string,
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
  }
}

export const marqs = singleton("marqs", getMarQSClient);

function getMarQSClient() {
  if (env.V3_ENABLED) {
    if (env.REDIS_HOST && env.REDIS_PORT) {
      return new MarQS({
        workers: 1,
        redis: {
          keyPrefix: KEY_PREFIX,
          port: env.REDIS_PORT,
          host: env.REDIS_HOST,
          username: env.REDIS_USERNAME,
          password: env.REDIS_PASSWORD,
          enableAutoPipelining: true,
          ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
        },
        defaultConcurrency: env.DEFAULT_ORG_EXECUTION_CONCURRENCY_LIMIT,
        visibilityTimeoutInMs: 120 * 1000, // 2 minutes
      });
    } else {
      console.warn(
        "Could not initialize MarQS because process.env.REDIS_HOST and process.env.REDIS_PORT are required to be set. Trigger.dev v3 will not work without this."
      );
    }
  }
}
