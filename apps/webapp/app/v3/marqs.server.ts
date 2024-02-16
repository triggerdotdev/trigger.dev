import Redis, { type Callback, type RedisOptions, type Result } from "ioredis";
import { z } from "zod";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { singleton } from "~/utils/singleton";
import { AsyncWorker } from "./marqs/asyncWorker.server";
import { logger } from "~/services/logger.server";

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
};

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

// TODO: heartbeats from the workers to ensure they're still alive

/**
 * MarQS - Modular Asynchronous Reliable Queueing System (pronounced "markus")
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

    await this.#callEnqueueMessage(messagePayload);
  }

  public async dequeueMessageInEnv(env: AuthenticatedEnvironment) {
    const parentQueue =
      env.type === "DEVELOPMENT"
        ? `${constants.ENV_PART}:${env.id}:${constants.SHARED_QUEUE}`
        : constants.SHARED_QUEUE;

    // Read the parent queue for matching queues
    const messageQueue = await this.#getRandomQueueFromParentQueue(parentQueue, (queue, score) =>
      this.#calculateMessageQueueWeight(queue, score)
    );

    if (!messageQueue) {
      return;
    }

    // If the queue includes a concurrency key, we need to remove the ck:concurrencyKey from the queue name
    const concurrencyQueueName = messageQueue.replace(/:ck:.+$/, "");

    const message = await this.#callDequeueMessage({
      messageQueue,
      parentQueue,
      visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
      concurrencyLimitKey: `${concurrencyQueueName}:${constants.CONCURRENCY_LIMIT_PART}`,
      currentConcurrencyKey: `${messageQueue}:${constants.CURRENT_CONCURRENCY_PART}`,
    });

    if (!message) {
      return;
    }

    return this.#readMessage(message.messageId);
  }

  public async acknowledgeMessage(messageId: string) {
    const message = await this.#readMessage(messageId);

    if (!message) {
      return;
    }

    await this.#callAcknowledgeMessage({
      messageKey: `${constants.MESSAGE_PART}:${messageId}`,
      visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
      concurrencyKey: `${message.queue}:${constants.CURRENT_CONCURRENCY_PART}`,
      messageId,
    });

    // await this.#callAcknowledgeMessage(
    //   `${constants.MESSAGE_PART}:${messageId}`,
    //   timeoutQueue,
    //   constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
    //   `${message.queue}:${constants.CURRENT_CONCURRENCY_PART}`,
    //   messageId
    // );
  }

  /**
   * Negative acknowledge a message, which will requeue the message
   */
  public async nackMessage(messageId: string) {
    const message = await this.#readMessage(messageId);

    if (!message) {
      return;
    }

    await this.#callNackMessage({
      messageKey: `${constants.MESSAGE_PART}:${messageId}`,
      messageQueue: message.queue,
      parentQueue: message.parentQueue,
      concurrencyKey: `${message.queue}:${constants.CURRENT_CONCURRENCY_PART}`,
      visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
      messageId,
      messageScore: message.timestamp,
    });
  }

  public async heartbeatMessage(messageId: string, seconds: number = 30) {
    await this.redis.zincrby(constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE, seconds * 1000, messageId);
  }

  async #readMessage(messageId: string) {
    const rawMessage = await this.redis.get(`${constants.MESSAGE_PART}:${messageId}`);

    if (!rawMessage) {
      return;
    }

    const message = MessagePayload.safeParse(JSON.parse(rawMessage));

    if (!message.success) {
      return;
    }

    return message.data;
  }

  async #getRandomQueueFromParentQueue(
    parentQueue: string,
    calculateWeight: (queue: string, score: number) => Promise<number>
  ) {
    const queues = await this.#zrangeWithScores(parentQueue, 0, -1);

    if (queues.length === 0) {
      return;
    }

    const queuesWithWeights = await this.#calculateQueueWeights(queues, calculateWeight);

    // We need to priority shuffle here to ensure all workers aren't just working on the highest priority queue
    return await this.#weightedRandomChoice(queuesWithWeights);
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
    const currentConcurrency = await this.redis.scard(
      `${queue}:${constants.CURRENT_CONCURRENCY_PART}`
    );

    const capacity = Number(concurrencyLimit) - Number(currentConcurrency);

    const capacityWeight = capacity / Number(concurrencyLimit);
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
    logger.debug("Calling dequeueMessage", {
      messageQueue,
      parentQueue,
      visibilityQueue,
      concurrencyLimitKey,
      currentConcurrencyKey,
    });

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

    logger.debug("Dequeue message result", {
      result,
    });

    if (!result) {
      return;
    }

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
local messageVisibility = redis.call('ZSCORE', visibilityQueue, messageId)

if messageVisibility == nil then
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
  }
}

export const marqs = singleton("marqs", getMarQSClient);

function getMarQSClient() {
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
      visibilityTimeoutInMs: 30 * 1000,
    });
  }
}
