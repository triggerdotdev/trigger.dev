import { Callback, createRedisClient, Redis, Result, type RedisOptions } from "@internal/redis";
import { Tracer } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { setInterval } from "node:timers/promises";
import { z } from "zod";

export type ReleaseConcurrencyQueueRetryOptions = {
  maxRetries?: number;
  backoff?: {
    minDelay?: number; // Defaults to 1000
    maxDelay?: number; // Defaults to 60000
    factor?: number; // Defaults to 2
  };
};

export type ReleaseConcurrencyQueueOptions<T> = {
  redis: RedisOptions;
  executor: (releaseQueue: T, runId: string) => Promise<void>;
  keys: {
    fromDescriptor: (releaseQueue: T) => string;
    toDescriptor: (releaseQueue: string) => T;
  };
  maxTokens: (descriptor: T) => Promise<number>;
  consumersCount?: number;
  masterQueuesKey?: string;
  tracer?: Tracer;
  logger?: Logger;
  pollInterval?: number;
  batchSize?: number;
  retry?: ReleaseConcurrencyQueueRetryOptions;
};

const QueueItemMetadata = z.object({
  retryCount: z.number(),
  lastAttempt: z.number(),
});

type QueueItemMetadata = z.infer<typeof QueueItemMetadata>;

export class ReleaseConcurrencyTokenBucketQueue<T> {
  private redis: Redis;
  private logger: Logger;
  private abortController: AbortController;
  private consumers: ReleaseConcurrencyQueueConsumer<T>[];

  private keyPrefix: string;
  private masterQueuesKey: string;
  private consumersCount: number;
  private pollInterval: number;
  private keys: ReleaseConcurrencyQueueOptions<T>["keys"];
  private maxTokens: ReleaseConcurrencyQueueOptions<T>["maxTokens"];
  private batchSize: number;
  private maxRetries: number;
  private backoff: NonNullable<Required<ReleaseConcurrencyQueueRetryOptions["backoff"]>>;

  constructor(private readonly options: ReleaseConcurrencyQueueOptions<T>) {
    this.redis = createRedisClient(options.redis);
    this.keyPrefix = options.redis.keyPrefix ?? "re2:release-concurrency-queue:";
    this.logger = options.logger ?? new Logger("ReleaseConcurrencyQueue");
    this.abortController = new AbortController();
    this.consumers = [];

    this.masterQueuesKey = options.masterQueuesKey ?? "master-queue";
    this.consumersCount = options.consumersCount ?? 1;
    this.pollInterval = options.pollInterval ?? 1000;
    this.keys = options.keys;
    this.maxTokens = options.maxTokens;
    this.batchSize = options.batchSize ?? 5;
    this.maxRetries = options.retry?.maxRetries ?? 3;
    this.backoff = {
      minDelay: options.retry?.backoff?.minDelay ?? 1000,
      maxDelay: options.retry?.backoff?.maxDelay ?? 60000,
      factor: options.retry?.backoff?.factor ?? 2,
    };

    this.#registerCommands();
    this.#startConsumers();
  }

  public async quit() {
    this.abortController.abort();
    await this.redis.quit();
  }

  /**
   * Attempt to release concurrency for a run.
   *
   * If there is a token available, then immediately release the concurrency
   * If there is no token available, then we'll add the operation to a queue
   * and wait until the token is available.
   */
  public async attemptToRelease(releaseQueueDescriptor: T, runId: string) {
    const maxTokens = await this.#callMaxTokens(releaseQueueDescriptor);

    if (maxTokens === 0) {
      return;
    }

    const releaseQueue = this.keys.fromDescriptor(releaseQueueDescriptor);

    const result = await this.redis.consumeToken(
      this.masterQueuesKey,
      this.#bucketKey(releaseQueue),
      this.#queueKey(releaseQueue),
      this.#metadataKey(releaseQueue),
      releaseQueue,
      runId,
      String(maxTokens),
      String(Date.now())
    );

    if (!!result) {
      await this.#callExecutor(releaseQueueDescriptor, runId, {
        retryCount: 0,
        lastAttempt: Date.now(),
      });
    }
  }

  /**
   * Refill the token bucket for a release queue.
   *
   * This will add the amount of tokens to the token bucket.
   */
  public async refillTokens(releaseQueueDescriptor: T, amount: number = 1) {
    const maxTokens = await this.#callMaxTokens(releaseQueueDescriptor);
    const releaseQueue = this.keys.fromDescriptor(releaseQueueDescriptor);

    if (amount < 0) {
      throw new Error("Cannot refill with negative tokens");
    }

    if (amount === 0) {
      return [];
    }

    await this.redis.refillTokens(
      this.masterQueuesKey,
      this.#bucketKey(releaseQueue),
      this.#queueKey(releaseQueue),
      releaseQueue,
      String(amount),
      String(maxTokens)
    );
  }

  /**
   * Get the next queue that has available capacity and process one item from it
   * Returns true if an item was processed, false if no items were available
   */
  public async processNextAvailableQueue(): Promise<boolean> {
    const result = await this.redis.processMasterQueue(
      this.masterQueuesKey,
      this.keyPrefix,
      this.batchSize,
      String(Date.now())
    );

    if (!result || result.length === 0) {
      return false;
    }

    await Promise.all(
      result.map(([queue, runId, metadata]) => {
        const itemMetadata = QueueItemMetadata.parse(JSON.parse(metadata));
        const releaseQueueDescriptor = this.keys.toDescriptor(queue);
        return this.#callExecutor(releaseQueueDescriptor, runId, itemMetadata);
      })
    );

    return true;
  }

  async #callExecutor(releaseQueueDescriptor: T, runId: string, metadata: QueueItemMetadata) {
    try {
      this.logger.info("Executing run:", { releaseQueueDescriptor, runId });

      await this.options.executor(releaseQueueDescriptor, runId);
    } catch (error) {
      this.logger.error("Error executing run:", { error });

      if (metadata.retryCount >= this.maxRetries) {
        this.logger.error("Max retries reached:", {
          releaseQueueDescriptor,
          runId,
          retryCount: metadata.retryCount,
        });

        // Return the token but don't requeue
        const releaseQueue = this.keys.fromDescriptor(releaseQueueDescriptor);
        await this.redis.returnTokenOnly(
          this.masterQueuesKey,
          this.#bucketKey(releaseQueue),
          this.#queueKey(releaseQueue),
          this.#metadataKey(releaseQueue),
          releaseQueue,
          runId
        );

        this.logger.info("Returned token:", { releaseQueueDescriptor, runId });

        return;
      }

      const updatedMetadata: QueueItemMetadata = {
        ...metadata,
        retryCount: metadata.retryCount + 1,
        lastAttempt: Date.now(),
      };

      const releaseQueue = this.keys.fromDescriptor(releaseQueueDescriptor);

      await this.redis.returnTokenAndRequeue(
        this.masterQueuesKey,
        this.#bucketKey(releaseQueue),
        this.#queueKey(releaseQueue),
        this.#metadataKey(releaseQueue),
        releaseQueue,
        runId,
        JSON.stringify(updatedMetadata),
        this.#calculateBackoffScore(updatedMetadata)
      );
    }
  }

  // Make sure maxTokens is an integer (round down)
  // And if it throws, return 0
  async #callMaxTokens(releaseQueueDescriptor: T) {
    try {
      const maxTokens = await this.maxTokens(releaseQueueDescriptor);
      return Math.floor(maxTokens);
    } catch (error) {
      return 0;
    }
  }

  #bucketKey(releaseQueue: string) {
    return `${releaseQueue}:bucket`;
  }

  #queueKey(releaseQueue: string) {
    return `${releaseQueue}:queue`;
  }

  #metadataKey(releaseQueue: string) {
    return `${releaseQueue}:metadata`;
  }

  #startConsumers() {
    const consumerCount = this.consumersCount;

    for (let i = 0; i < consumerCount; i++) {
      const consumer = new ReleaseConcurrencyQueueConsumer(
        this,
        this.pollInterval,
        this.abortController.signal,
        this.logger
      );
      this.consumers.push(consumer);
      // Start the consumer and don't await it
      consumer.start().catch((error) => {
        this.logger.error("Consumer failed to start:", { error, consumerId: i });
      });
    }
  }

  #calculateBackoffScore(item: QueueItemMetadata): string {
    const delay = Math.min(
      this.backoff.maxDelay,
      this.backoff.minDelay * Math.pow(this.backoff.factor, item.retryCount)
    );
    return String(Date.now() + delay);
  }

  #registerCommands() {
    this.redis.defineCommand("consumeToken", {
      numberOfKeys: 4,
      lua: `
local masterQueuesKey = KEYS[1]
local bucketKey = KEYS[2]
local queueKey = KEYS[3]
local metadataKey = KEYS[4]

local releaseQueue = ARGV[1]
local runId = ARGV[2]
local maxTokens = tonumber(ARGV[3])
local score = ARGV[4]

-- Get the current token count
local currentTokens = tonumber(redis.call("GET", bucketKey) or maxTokens)

-- If we have enough tokens, then consume them
if currentTokens >= 1 then
  redis.call("SET", bucketKey, currentTokens - 1)
  redis.call("ZREM", queueKey, runId)

  -- Clean up metadata when successfully consuming
  redis.call("HDEL", metadataKey, runId)

  -- Get queue length after removing the item
  local queueLength = redis.call("ZCARD", queueKey)

  -- If we still have tokens and items in queue, update available queues
  if currentTokens > 0 and queueLength > 0 then
    redis.call("ZADD", masterQueuesKey, currentTokens, releaseQueue)
  else
    redis.call("ZREM", masterQueuesKey, releaseQueue)
  end

  return true
end

-- If we don't have enough tokens, then we need to add the operation to the queue
redis.call("ZADD", queueKey, score, runId)

-- Initialize or update metadata
local metadata = cjson.encode({
  retryCount = 0,
  lastAttempt = tonumber(score)
})
redis.call("HSET", metadataKey, runId, metadata)

-- Remove from the master queue
redis.call("ZREM", masterQueuesKey, releaseQueue)

return false
      `,
    });

    this.redis.defineCommand("refillTokens", {
      numberOfKeys: 3,
      lua: `
local masterQueuesKey = KEYS[1]
local bucketKey = KEYS[2]
local queueKey = KEYS[3]

local releaseQueue = ARGV[1]
local amount = tonumber(ARGV[2])
local maxTokens = tonumber(ARGV[3])

local currentTokens = tonumber(redis.call("GET", bucketKey) or maxTokens)

-- Add the amount of tokens to the token bucket
local newTokens = currentTokens + amount

-- If we have more tokens than the max, then set the token bucket to the max
if newTokens > maxTokens then
  newTokens = maxTokens
end

redis.call("SET", bucketKey, newTokens)

-- Get the number of items in the queue
local queueLength = redis.call("ZCARD", queueKey)

-- If we have tokens available and items in the queue, add to available queues
if newTokens > 0 and queueLength > 0 then
  redis.call("ZADD", masterQueuesKey, newTokens, releaseQueue)
else
  redis.call("ZREM", masterQueuesKey, releaseQueue)
end
      `,
    });

    this.redis.defineCommand("processMasterQueue", {
      numberOfKeys: 1,
      lua: `
local masterQueuesKey = KEYS[1]

local keyPrefix = ARGV[1]
local batchSize = tonumber(ARGV[2])
local currentTime = tonumber(ARGV[3])
-- Get the queue with the highest number of available tokens
local queues = redis.call("ZREVRANGE", masterQueuesKey, 0, 0, "WITHSCORES")
if #queues == 0 then
  return nil
end

local queueName = queues[1]
local availableTokens = tonumber(queues[2])

local bucketKey = keyPrefix .. queueName .. ":bucket"
local queueKey = keyPrefix .. queueName .. ":queue"
local metadataKey = keyPrefix .. queueName .. ":metadata"

-- Get the oldest item from the queue
local items = redis.call("ZRANGEBYSCORE", queueKey, 0, currentTime, "LIMIT", 0, batchSize - 1)
if #items == 0 then
-- No items ready to be processed yet
  return nil
end

-- Calculate how many items we can actually process
local itemsToProcess = math.min(#items, availableTokens)
local results = {}

-- Consume tokens and collect results
local currentTokens = tonumber(redis.call("GET", bucketKey))
redis.call("SET", bucketKey, currentTokens - itemsToProcess)

-- Remove the items from the queue and add to results
for i = 1, itemsToProcess do
  local runId = items[i]
  redis.call("ZREM", queueKey, runId)

  -- Get metadata before removing it
  local metadata = redis.call("HGET", metadataKey, runId)
  redis.call("HDEL", metadataKey, runId)

  table.insert(results, { queueName, runId, metadata })
end

-- Get remaining queue length
local queueLength = redis.call("ZCARD", queueKey)

-- Update available queues score or remove if no more tokens
local remainingTokens = currentTokens - itemsToProcess
if remainingTokens > 0 and queueLength > 0 then
  redis.call("ZADD", masterQueuesKey, remainingTokens, queueName)
else
  redis.call("ZREM", masterQueuesKey, queueName)
end

return results
      `,
    });

    this.redis.defineCommand("returnTokenAndRequeue", {
      numberOfKeys: 4,
      lua: `
local masterQueuesKey = KEYS[1]
local bucketKey = KEYS[2]
local queueKey = KEYS[3]  
local metadataKey = KEYS[4]

local releaseQueue = ARGV[1]
local runId = ARGV[2]
local metadata = ARGV[3]
local score = ARGV[4]

--  Return the token to the bucket
local currentTokens = tonumber(redis.call("GET", bucketKey))
local remainingTokens = currentTokens + 1
redis.call("SET", bucketKey, remainingTokens)

-- Add the item back to the queue
redis.call("ZADD", queueKey, score, runId)

-- Add the metadata back to the item
redis.call("HSET", metadataKey, runId, metadata)

-- Update the master queue
local queueLength = redis.call("ZCARD", queueKey)
if queueLength > 0 then
  redis.call("ZADD", masterQueuesKey, remainingTokens, releaseQueue)
else
  redis.call("ZREM", masterQueuesKey, releaseQueue)
end

return true
      `,
    });

    this.redis.defineCommand("returnTokenOnly", {
      numberOfKeys: 4,
      lua: `
local masterQueuesKey = KEYS[1]
local bucketKey = KEYS[2]
local queueKey = KEYS[3]
local metadataKey = KEYS[4]

local releaseQueue = ARGV[1]
local runId = ARGV[2]

-- Return the token to the bucket
local currentTokens = tonumber(redis.call("GET", bucketKey))
local remainingTokens = currentTokens + 1
redis.call("SET", bucketKey, remainingTokens)

-- Clean up metadata
redis.call("HDEL", metadataKey, runId)

-- Update the master queue based on remaining queue length
local queueLength = redis.call("ZCARD", queueKey)
if queueLength > 0 then
  redis.call("ZADD", masterQueuesKey, remainingTokens, releaseQueue)
else
  redis.call("ZREM", masterQueuesKey, releaseQueue)
end

return true
      `,
    });
  }
}

declare module "@internal/redis" {
  interface RedisCommander<Context> {
    consumeToken(
      masterQueuesKey: string,
      bucketKey: string,
      queueKey: string,
      metadataKey: string,
      releaseQueue: string,
      runId: string,
      maxTokens: string,
      score: string,
      callback?: Callback<string>
    ): Result<string, Context>;

    refillTokens(
      masterQueuesKey: string,
      bucketKey: string,
      queueKey: string,
      releaseQueue: string,
      amount: string,
      maxTokens: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    processMasterQueue(
      masterQueuesKey: string,
      keyPrefix: string,
      batchSize: number,
      currentTime: string,
      callback?: Callback<[string, string, string][]>
    ): Result<[string, string, string][], Context>;

    returnTokenAndRequeue(
      masterQueuesKey: string,
      bucketKey: string,
      queueKey: string,
      metadataKey: string,
      releaseQueue: string,
      runId: string,
      metadata: string,
      score: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    returnTokenOnly(
      masterQueuesKey: string,
      bucketKey: string,
      queueKey: string,
      metadataKey: string,
      releaseQueue: string,
      runId: string,
      callback?: Callback<void>
    ): Result<void, Context>;
  }
}

class ReleaseConcurrencyQueueConsumer<T> {
  private logger: Logger;

  constructor(
    private readonly queue: ReleaseConcurrencyTokenBucketQueue<T>,
    private readonly pollInterval: number,
    private readonly signal: AbortSignal,
    logger?: Logger
  ) {
    this.logger = logger ?? new Logger("QueueConsumer");
  }

  async start() {
    try {
      for await (const _ of setInterval(this.pollInterval, null, { signal: this.signal })) {
        try {
          const processed = await this.queue.processNextAvailableQueue();
          if (!processed) {
            continue;
          }
        } catch (error) {
          this.logger.error("Error processing queue:", { error });
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        this.logger.error("Consumer loop error:", { error });
      }
    }
  }
}
