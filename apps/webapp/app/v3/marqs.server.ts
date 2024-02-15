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
  visibilityTimeout?: number;
  workers: number;
};

const constants = {
  SHARED_QUEUE: "sharedQueue",
  SHARED_TIMEOUT_QUEUE: "timeoutQueue",
  CURRENT_CONCURRENCY_PART: "currentConcurrency",
  CONCURRENCY_LIMIT_PART: "concurrency",
  TIMEOUT_PART: "timeout",
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

    const message = await this.#callDequeueMessage(
      messageQueue,
      parentQueue,
      `${messageQueue}:${constants.TIMEOUT_PART}`,
      constants.SHARED_TIMEOUT_QUEUE,
      `${concurrencyQueueName}:${constants.CONCURRENCY_LIMIT_PART}`,
      `${messageQueue}:${constants.CURRENT_CONCURRENCY_PART}`
    );

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

    const timeoutQueue = `${message.queue}:${constants.TIMEOUT_PART}`;

    await this.#callAcknowledgeMessage(
      `${constants.MESSAGE_PART}:${messageId}`,
      timeoutQueue,
      constants.SHARED_TIMEOUT_QUEUE,
      `${message.queue}:${constants.CURRENT_CONCURRENCY_PART}`,
      messageId
    );
  }

  /**
   * Negative acknowledge a message, which will requeue the message
   */
  public async nackMessage(messageId: string) {
    const message = await this.#readMessage(messageId);

    if (!message) {
      return;
    }

    // Need to remove the message from the timeout queue and "rebalance" the TIMEOUT parent queue
    const timeoutQueue = `${message.queue}:${constants.TIMEOUT_PART}`;

    await this.#callNackMessage(
      `${constants.MESSAGE_PART}:${messageId}`,
      message.queue,
      message.parentQueue,
      `${message.queue}:${constants.CURRENT_CONCURRENCY_PART}`,
      timeoutQueue,
      constants.SHARED_TIMEOUT_QUEUE,
      messageId,
      message.timestamp
    );
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
    const currentConcurrency = await this.redis.get(
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

  async #rebalanceParentQueueForChildQueue({
    parentQueue,
    childQueue,
  }: {
    parentQueue: string;
    childQueue: string;
  }) {
    // Get the earliest task from the child queue
    const earliestTask = await this.redis.zrange(childQueue, 0, 0, "WITHSCORES");

    if (earliestTask.length === 0) {
      // Remove the child queue from the parent queue

      return this.redis.zrem(parentQueue, childQueue);
    }

    // Update the score of the child queue in the parent queue
    return this.redis.zadd(parentQueue, earliestTask[1], childQueue);
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
    const timeoutQueue = await this.#getRandomQueueFromParentQueue(
      constants.SHARED_TIMEOUT_QUEUE,
      (queue, score) => Promise.resolve(Date.now() - score)
    );

    if (!timeoutQueue) {
      return;
    }

    // Remove any of the messages from the timeoutQueue that have expired
    const messages = await this.redis.zrangebyscore(timeoutQueue, 0, Date.now());

    if (messages.length === 0) {
      return;
    }

    const messageQueue = timeoutQueue.replace(`:${constants.TIMEOUT_PART}`, "");

    await this.redis.zrem(timeoutQueue, ...messages);
    await this.redis.zadd(messageQueue, Date.now(), ...messages);

    const messagePayloads = await Promise.all(
      messages.map((messageId) => this.#readMessage(messageId))
    ).then((messages) => messages.filter(Boolean));

    const rebalances: Map<string, { parentQueue: string; childQueue: string }> = new Map();

    for (const messagePayload of messagePayloads) {
      if (!messagePayload) {
        continue;
      }

      rebalances.set(`${messagePayload.parentQueue}:${messagePayload.queue}`, {
        parentQueue: messagePayload.parentQueue,
        childQueue: messageQueue,
      });
    }

    await Promise.all(
      Array.from(rebalances.values()).map(({ parentQueue, childQueue }) =>
        this.#rebalanceParentQueueForChildQueue({ parentQueue, childQueue })
      )
    );

    await this.#rebalanceParentQueueForChildQueue({
      parentQueue: constants.SHARED_TIMEOUT_QUEUE,
      childQueue: timeoutQueue,
    });
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

  async #callDequeueMessage(
    childQueue: string,
    parentQueue: string,
    timeoutQueue: string,
    timeoutParentQueue: string,
    concurrencyLimitKey: string,
    currentConcurrencyKey: string
  ) {
    logger.debug("Calling dequeueMessage", {
      childQueue,
      parentQueue,
      timeoutQueue,
      timeoutParentQueue,
      concurrencyLimitKey,
      currentConcurrencyKey,
    });

    const result = await this.redis.dequeueMessage(
      childQueue,
      parentQueue,
      timeoutQueue,
      timeoutParentQueue,
      concurrencyLimitKey,
      currentConcurrencyKey,
      childQueue,
      timeoutQueue,
      String(this.options.visibilityTimeout ?? 300000),
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

  async #callAcknowledgeMessage(
    messageKey: string,
    timeoutQueue: string,
    timeoutParentQueue: string,
    concurrencyKey: string,
    messageId: string
  ) {
    logger.debug("Calling acknowledgeMessage", {
      messageKey,
      timeoutQueue,
      timeoutParentQueue,
      concurrencyKey,
      messageId,
    });

    return this.redis.acknowledgeMessage(
      messageKey,
      timeoutQueue,
      timeoutParentQueue,
      concurrencyKey,
      timeoutParentQueue,
      messageId
    );
  }

  async #callNackMessage(
    messageKey: string,
    childQueueKey: string,
    parentQueueKey: string,
    concurrencyKey: string,
    timeoutQueue: string,
    timeoutParentQueue: string,
    messageId: string,
    messageScore: number
  ) {
    logger.debug("Calling nackMessage", {
      messageKey,
      childQueueKey,
      parentQueueKey,
      concurrencyKey,
      timeoutQueue,
      timeoutParentQueue,
      messageId,
      messageScore,
    });

    return this.redis.nackMessage(
      messageKey,
      childQueueKey,
      parentQueueKey,
      concurrencyKey,
      timeoutQueue,
      timeoutParentQueue,
      childQueueKey,
      timeoutQueue,
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
      numberOfKeys: 6,
      lua: `
-- Keys: childQueue, parentQueue, timeoutQueue, timeoutParentQueue, concurrencyLimitKey, currentConcurrencyKey
-- Args: visibilityTimeout, currentTime
local childQueue = KEYS[1]
local parentQueue = KEYS[2]
local timeoutQueue = KEYS[3]
local timeoutParentQueue = KEYS[4]
local concurrencyLimitKey = KEYS[5]
local currentConcurrencyKey = KEYS[6]
local childQueueName = ARGV[1]
local timeoutQueueName = ARGV[2]
local visibilityTimeout = tonumber(ARGV[3])
local currentTime = tonumber(ARGV[4])
local defaultConcurrencyLimit = ARGV[5]

-- Check current concurrency against the limit
local currentConcurrency = tonumber(redis.call('GET', currentConcurrencyKey) or '0')
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
    redis.call('ZADD', timeoutQueue, timeoutScore, messageId)
    redis.call('INCR', currentConcurrencyKey)

    -- Rebalance the parent queue
    local earliestMessage = redis.call('ZRANGE', childQueue, 0, 0, 'WITHSCORES')
    if #earliestMessage == 0 then
        redis.call('ZREM', parentQueue, childQueueName)
    else
        redis.call('ZADD', parentQueue, earliestMessage[2], childQueueName)
    end

    -- Rebalance the timeout parent queue
    local earliestTimeoutMessage = redis.call('ZRANGE', timeoutQueue, 0, 0, 'WITHSCORES')
    if #earliestTimeoutMessage == 0 then
        redis.call('ZREM', timeoutParentQueue, timeoutQueueName)
    else
        redis.call('ZADD', timeoutParentQueue, earliestTimeoutMessage[2], timeoutQueueName)
    end
    
    return {messageId, messageScore} -- Return message details
end

return nil

      `,
    });

    this.redis.defineCommand("acknowledgeMessage", {
      numberOfKeys: 4,
      lua: `
-- Keys: messageKey, timeoutQueue, timeoutParentQueue, concurrencyKey
local messageKey = KEYS[1]
local timeoutQueue = KEYS[2]
local timeoutParentQueue = KEYS[3]
local concurrencyKey = KEYS[4]

local timeoutQueueName = ARGV[1]
local messageId = ARGV[2]

-- Remove the message from the message key
redis.call('DEL', messageKey)

-- Remove the message from the timeout queue
redis.call('ZREM', timeoutQueue, messageId)

-- Update the concurrency key
redis.call('DECR', concurrencyKey)

-- Rebalance the timeout parent queue
local earliestTimeoutMessage = redis.call('ZRANGE', timeoutQueue, 0, 0, 'WITHSCORES')
if #earliestTimeoutMessage == 0 then
    redis.call('ZREM', timeoutParentQueue, timeoutQueueName)
else
    redis.call('ZADD', timeoutParentQueue, earliestTimeoutMessage[2], timeoutQueueName)
end
`,
    });

    this.redis.defineCommand("nackMessage", {
      numberOfKeys: 6,
      lua: `
-- Keys: childQueueKey, parentQueueKey, timeoutQueue, timeoutParentQueue, concurrencyKey, messageId
local messageKey = KEYS[1]
local childQueueKey = KEYS[2]
local parentQueueKey = KEYS[3]
local concurrencyKey = KEYS[4]
local timeoutQueue = KEYS[5]
local timeoutParentQueue = KEYS[6]

-- Args: messageId, currentTime, messageScore
local childQueueName = ARGV[1]
local timeoutQueueName = ARGV[2]
local messageId = ARGV[3]
local currentTime = tonumber(ARGV[4])
local messageScore = tonumber(ARGV[5])

-- Update the concurrency key
redis.call('DECR', concurrencyKey)

-- Remove the message from the timeout queue
redis.call('ZREM', timeoutQueue, messageId)

-- Enqueue the message into the queue
redis.call('ZADD', childQueueKey, messageScore, messageId)

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', childQueueKey, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueueKey, childQueueName)
else
    redis.call('ZADD', parentQueueKey, earliestMessage[2], childQueueName)
end

-- Rebalance the timeout parent queue
local earliestTimeoutMessage = redis.call('ZRANGE', timeoutQueue, 0, 0, 'WITHSCORES')

if #earliestTimeoutMessage == 0 then
    redis.call('ZREM', timeoutParentQueue, timeoutQueueName)
else
    redis.call('ZADD', timeoutParentQueue, earliestTimeoutMessage[2], timeoutQueueName)
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
      timeoutQueue: string,
      timeoutParentQueue: string,
      concurrencyLimitKey: string,
      currentConcurrencyKey: string,
      childQueueName: string,
      timeoutQueueName: string,
      visibilityTimeout: string,
      currentTime: string,
      defaultConcurrencyLimit: string,
      callback?: Callback<[string, string]>
    ): Result<[string, string] | null, Context>;

    acknowledgeMessage(
      messageKey: string,
      timeoutQueue: string,
      timeoutParentQueue: string,
      concurrencyKey: string,
      timeoutQueueName: string,
      messageId: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    nackMessage(
      messageKey: string,
      childQueueKey: string,
      parentQueueKey: string,
      concurrencyKey: string,
      timeoutQueue: string,
      timeoutParentQueue: string,
      childQueueName: string,
      timeoutQueueName: string,
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
    });
  }
}
