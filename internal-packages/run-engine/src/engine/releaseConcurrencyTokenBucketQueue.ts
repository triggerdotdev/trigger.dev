import { Callback, createRedisClient, Redis, Result, type RedisOptions } from "@internal/redis";
import { startSpan, Tracer } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { z } from "zod";
import { setInterval } from "node:timers/promises";
import { flattenAttributes } from "@trigger.dev/core/v3";

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
  /**
   * @returns true if the run was successful, false if the token should be returned to the bucket
   */
  executor: (releaseQueue: T, releaserId: string) => Promise<boolean>;
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
  disableConsumers?: boolean;
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

    if (!options.disableConsumers) {
      this.#startConsumers();
      this.#startMetricsProducer();
    }
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
  public async attemptToRelease(releaseQueueDescriptor: T, releaserId: string) {
    const maxTokens = await this.#callMaxTokens(releaseQueueDescriptor);

    if (maxTokens === 0) {
      this.logger.debug("No tokens available, skipping release", {
        releaseQueueDescriptor,
        releaserId,
        maxTokens,
      });

      return;
    }

    const releaseQueue = this.keys.fromDescriptor(releaseQueueDescriptor);

    const result = await this.redis.consumeToken(
      this.masterQueuesKey,
      this.#bucketKey(releaseQueue),
      this.#queueKey(releaseQueue),
      this.#metadataKey(releaseQueue),
      releaseQueue,
      releaserId,
      String(maxTokens),
      String(Date.now())
    );

    this.logger.info("Consumed token in attemptToRelease", {
      releaseQueueDescriptor,
      releaserId,
      maxTokens,
      result,
      releaseQueue,
    });

    if (!!result) {
      await this.#callExecutor(releaseQueueDescriptor, releaserId, {
        retryCount: 0,
        lastAttempt: Date.now(),
      });
    } else {
      this.logger.info("No token available, adding to queue", {
        releaseQueueDescriptor,
        releaserId,
        maxTokens,
        releaseQueue,
      });
    }
  }

  /**
   * Consume a token from the token bucket for a release queue.
   *
   * This is mainly used for testing purposes
   */
  public async consumeToken(releaseQueueDescriptor: T, releaserId: string) {
    const maxTokens = await this.#callMaxTokens(releaseQueueDescriptor);
    const releaseQueue = this.keys.fromDescriptor(releaseQueueDescriptor);

    if (maxTokens === 0) {
      this.logger.debug("No tokens available, skipping consume", {
        releaseQueueDescriptor,
        releaserId,
        maxTokens,
        releaseQueue,
      });

      return;
    }

    await this.redis.consumeToken(
      this.masterQueuesKey,
      this.#bucketKey(releaseQueue),
      this.#queueKey(releaseQueue),
      this.#metadataKey(releaseQueue),
      releaseQueue,
      releaserId,
      String(maxTokens),
      String(Date.now())
    );

    this.logger.debug("Consumed token in consumeToken", {
      releaseQueueDescriptor,
      releaserId,
      maxTokens,
      releaseQueue,
    });
  }

  /**
   * Return a token to the token bucket for a release queue.
   *
   * This is mainly used for testing purposes
   */
  public async returnToken(releaseQueueDescriptor: T, releaserId: string) {
    const releaseQueue = this.keys.fromDescriptor(releaseQueueDescriptor);

    this.logger.debug("Returning token in returnToken", {
      releaseQueueDescriptor,
      releaserId,
    });

    await this.redis.returnTokenOnly(
      this.masterQueuesKey,
      this.#bucketKey(releaseQueue),
      this.#queueKey(releaseQueue),
      this.#metadataKey(releaseQueue),
      releaseQueue,
      releaserId
    );

    this.logger.debug("Returned token in returnToken", {
      releaseQueueDescriptor,
      releaserId,
      releaseQueue,
    });
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
      this.logger.debug("Cannot refill with negative tokens", {
        releaseQueueDescriptor,
        amount,
      });

      throw new Error("Cannot refill with negative tokens");
    }

    if (amount === 0) {
      this.logger.debug("Cannot refill with 0 tokens", {
        releaseQueueDescriptor,
        amount,
      });

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

    this.logger.debug("Refilled tokens in refillTokens", {
      releaseQueueDescriptor,
      releaseQueue,
      amount,
      maxTokens,
    });
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

    await Promise.allSettled(
      result.map(([queue, releaserId, metadata]) => {
        const itemMetadata = QueueItemMetadata.parse(JSON.parse(metadata));
        const releaseQueueDescriptor = this.keys.toDescriptor(queue);
        return this.#callExecutor(releaseQueueDescriptor, releaserId, itemMetadata);
      })
    );

    return true;
  }

  async #callExecutor(releaseQueueDescriptor: T, releaserId: string, metadata: QueueItemMetadata) {
    try {
      this.logger.info("Calling executor for release", { releaseQueueDescriptor, releaserId });

      const released = await this.options.executor(releaseQueueDescriptor, releaserId);

      if (released) {
        this.logger.info("Executor released concurrency", { releaseQueueDescriptor, releaserId });
      } else {
        this.logger.info("Executor did not release concurrency", {
          releaseQueueDescriptor,
          releaserId,
        });

        // Return the token but don't requeue
        const releaseQueue = this.keys.fromDescriptor(releaseQueueDescriptor);
        await this.redis.returnTokenOnly(
          this.masterQueuesKey,
          this.#bucketKey(releaseQueue),
          this.#queueKey(releaseQueue),
          this.#metadataKey(releaseQueue),
          releaseQueue,
          releaserId
        );
      }
    } catch (error) {
      this.logger.error("Error executing run:", { error });

      if (metadata.retryCount >= this.maxRetries) {
        this.logger.error("Max retries reached:", {
          releaseQueueDescriptor,
          releaserId,
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
          releaserId
        );

        this.logger.info("Returned token:", { releaseQueueDescriptor, releaserId });

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
        releaserId,
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

  async #startMetricsProducer() {
    try {
      // Produce metrics every 60 seconds, using a tracer span
      for await (const _ of setInterval(60_000)) {
        const metrics = await this.getQueueMetrics();
        this.logger.info("Queue metrics:", { metrics });

        await startSpan(
          this.options.tracer,
          "ReleaseConcurrencyTokenBucketQueue.metrics",
          async (span) => {},
          {
            attributes: {
              ...flattenAttributes(metrics, "queues"),
              forceRecording: true,
            },
          }
        );
      }
    } catch (error) {
      this.logger.error("Error starting metrics producer:", { error });
    }
  }

  #calculateBackoffScore(item: QueueItemMetadata): string {
    const delay = Math.min(
      this.backoff.maxDelay,
      this.backoff.minDelay * Math.pow(this.backoff.factor, item.retryCount)
    );
    return String(Date.now() + delay);
  }

  async getQueueMetrics(): Promise<
    Array<{ releaseQueue: string; currentTokens: number; queueLength: number }>
  > {
    const streamRedis = this.redis.duplicate();
    const queuePattern = `${this.keyPrefix}*:queue`;
    const stream = streamRedis.scanStream({
      match: queuePattern,
      type: "zset",
      count: 100,
    });

    let resolvePromise: (
      value: Array<{ releaseQueue: string; currentTokens: number; queueLength: number }>
    ) => void;
    let rejectPromise: (reason?: any) => void;

    const promise = new Promise<
      Array<{ releaseQueue: string; currentTokens: number; queueLength: number }>
    >((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const metrics: Map<
      string,
      { releaseQueue: string; currentTokens: number; queueLength: number }
    > = new Map();

    async function getMetricsForKeys(queueKeys: string[]) {
      if (queueKeys.length === 0) {
        return [];
      }

      const pipeline = streamRedis.pipeline();

      queueKeys.forEach((queueKey) => {
        const releaseQueue = queueKey
          .replace(":queue", "")
          .replace(streamRedis.options.keyPrefix ?? "", "");
        const bucketKey = `${releaseQueue}:bucket`;

        pipeline.get(bucketKey);
        pipeline.zcard(`${releaseQueue}:queue`);
      });

      const result = await pipeline.exec();

      if (!result) {
        return [];
      }

      const results = result.map(([resultError, queueLengthOrCurrentTokens]) => {
        if (resultError) {
          return null;
        }

        return queueLengthOrCurrentTokens ? Number(queueLengthOrCurrentTokens) : 0;
      });

      // Now zip the results with the queue keys
      const zippedResults = queueKeys.map((queueKey, index) => {
        const releaseQueue = queueKey
          .replace(":queue", "")
          .replace(streamRedis.options.keyPrefix ?? "", "");

        // Current tokens are at indexes 0, 2, 4, 6, etc.
        // Queue length are at indexes 1, 3, 5, 7, etc.

        const currentTokens = results[index * 2];
        const queueLength = results[index * 2 + 1];

        if (typeof currentTokens !== "number" || typeof queueLength !== "number") {
          return null;
        }

        return {
          releaseQueue,
          currentTokens: currentTokens,
          queueLength: queueLength,
        };
      });

      return zippedResults.filter((result) => result !== null);
    }

    stream.on("end", () => {
      streamRedis.quit();
      resolvePromise(Array.from(metrics.values()));
    });

    stream.on("error", (error) => {
      this.logger.error("Error getting queue metrics:", { error });

      stream.pause();
      streamRedis.quit();
      rejectPromise(error);
    });

    stream.on("data", async (keys) => {
      stream.pause();

      const uniqueKeys = Array.from(new Set<string>(keys));

      if (uniqueKeys.length === 0) {
        stream.resume();
        return;
      }

      const unresolvedKeys = uniqueKeys.filter((key) => !metrics.has(key));

      if (unresolvedKeys.length === 0) {
        stream.resume();
        return;
      }

      this.logger.debug("Fetching queue metrics for keys", { keys: uniqueKeys });

      await getMetricsForKeys(unresolvedKeys).then((results) => {
        results.forEach((result) => {
          if (result) {
            metrics.set(result.releaseQueue, result);
          }
        });

        stream.resume();
      });
    });

    return promise;
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
local releaserId = ARGV[2]
local maxTokens = tonumber(ARGV[3])
local score = ARGV[4]

-- Get the current token count
local currentTokens = tonumber(redis.call("GET", bucketKey) or maxTokens)

-- If we have enough tokens, then consume them
if currentTokens >= 1 then
  local newCurrentTokens = currentTokens - 1

  redis.call("SET", bucketKey, newCurrentTokens)
  redis.call("ZREM", queueKey, releaserId)

  -- Clean up metadata when successfully consuming
  redis.call("HDEL", metadataKey, releaserId)

  -- Get queue length after removing the item
  local queueLength = redis.call("ZCARD", queueKey)

  -- If we still have tokens and items in queue, update available queues
  if newCurrentTokens > 0 and queueLength > 0 then
    redis.call("ZADD", masterQueuesKey, newCurrentTokens, releaseQueue)
  else
    redis.call("ZREM", masterQueuesKey, releaseQueue)
  end

  return true
end

-- If we don't have enough tokens, then we need to add the operation to the queue
redis.call("ZADD", queueKey, score, releaserId)

-- Initialize or update metadata
local metadata = cjson.encode({
  retryCount = 0,
  lastAttempt = tonumber(score)
})
redis.call("HSET", metadataKey, releaserId, metadata)

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
local items = redis.call("ZRANGEBYSCORE", queueKey, 0, currentTime, "LIMIT", 0, batchSize)
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
  local releaserId = items[i]
  redis.call("ZREM", queueKey, releaserId)

  -- Get metadata before removing it
  local metadata = redis.call("HGET", metadataKey, releaserId)
  redis.call("HDEL", metadataKey, releaserId)

  table.insert(results, { queueName, releaserId, metadata })
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
local releaserId = ARGV[2]
local metadata = ARGV[3]
local score = ARGV[4]

--  Return the token to the bucket
local currentTokens = tonumber(redis.call("GET", bucketKey))
local remainingTokens = currentTokens + 1
redis.call("SET", bucketKey, remainingTokens)

-- Add the item back to the queue
redis.call("ZADD", queueKey, score, releaserId)

-- Add the metadata back to the item
redis.call("HSET", metadataKey, releaserId, metadata)

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
local releaserId = ARGV[2]

-- Return the token to the bucket
local currentTokens = tonumber(redis.call("GET", bucketKey))
local remainingTokens = currentTokens + 1
redis.call("SET", bucketKey, remainingTokens)

-- Clean up metadata
redis.call("HDEL", metadataKey, releaserId)

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
      releaserId: string,
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
      releaserId: string,
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
      releaserId: string,
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
