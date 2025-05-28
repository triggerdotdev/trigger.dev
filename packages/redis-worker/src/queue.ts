import {
  createRedisClient,
  type Redis,
  type Callback,
  type RedisOptions,
  type Result,
} from "@internal/redis";
import { Logger } from "@trigger.dev/core/logger";
import { nanoid } from "nanoid";
import { z } from "zod";

export interface MessageCatalogSchema {
  [key: string]: z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>;
}

export type MessageCatalogKey<TMessageCatalog extends MessageCatalogSchema> = keyof TMessageCatalog;
export type MessageCatalogValue<
  TMessageCatalog extends MessageCatalogSchema,
  TKey extends MessageCatalogKey<TMessageCatalog>,
> = z.infer<TMessageCatalog[TKey]>;

export type AnyMessageCatalog = MessageCatalogSchema;
export type QueueItem<TMessageCatalog extends MessageCatalogSchema> = {
  id: string;
  job: MessageCatalogKey<TMessageCatalog>;
  item: MessageCatalogValue<TMessageCatalog, MessageCatalogKey<TMessageCatalog>>;
  visibilityTimeoutMs: number;
  attempt: number;
  timestamp: Date;
  deduplicationKey?: string;
};

export type AnyQueueItem = {
  id: string;
  job: string;
  item: any;
  visibilityTimeoutMs: number;
  attempt: number;
  timestamp: Date;
  deduplicationKey?: string;
};

export class SimpleQueue<TMessageCatalog extends MessageCatalogSchema> {
  name: string;
  private redis: Redis;
  private schema: TMessageCatalog;
  private logger: Logger;

  constructor({
    name,
    schema,
    redisOptions,
    logger,
  }: {
    name: string;
    schema: TMessageCatalog;
    redisOptions: RedisOptions;
    logger?: Logger;
  }) {
    this.name = name;
    this.logger = logger ?? new Logger("SimpleQueue", "debug");

    this.redis = createRedisClient(
      {
        ...redisOptions,
        keyPrefix: `${redisOptions.keyPrefix ?? ""}{queue:${name}:}`,
        retryStrategy(times) {
          const delay = Math.min(times * 50, 1000);
          return delay;
        },
        maxRetriesPerRequest: 20,
      },
      {
        onError: (error) => {
          this.logger.error(`RedisWorker queue redis client error:`, {
            error,
            keyPrefix: redisOptions.keyPrefix,
          });
        },
      }
    );
    this.#registerCommands();
    this.schema = schema;
  }

  async enqueue({
    id,
    job,
    item,
    attempt,
    availableAt,
    visibilityTimeoutMs,
  }: {
    id?: string;
    job: MessageCatalogKey<TMessageCatalog>;
    item: MessageCatalogValue<TMessageCatalog, MessageCatalogKey<TMessageCatalog>>;
    attempt?: number;
    availableAt?: Date;
    visibilityTimeoutMs: number;
  }): Promise<void> {
    try {
      const score = availableAt ? availableAt.getTime() : Date.now();
      const deduplicationKey = nanoid();
      const serializedItem = JSON.stringify({
        job,
        item,
        visibilityTimeoutMs,
        attempt,
        deduplicationKey,
      });

      const result = await this.redis.enqueueItem(
        `queue`,
        `items`,
        id ?? nanoid(),
        score,
        serializedItem
      );

      if (result !== 1) {
        throw new Error("Enqueue operation failed");
      }
    } catch (e) {
      this.logger.error(`SimpleQueue ${this.name}.enqueue(): error enqueuing`, {
        queue: this.name,
        error: e,
        id,
        item,
      });
      throw e;
    }
  }

  async enqueueOnce({
    id,
    job,
    item,
    attempt,
    availableAt,
    visibilityTimeoutMs,
  }: {
    id: string;
    job: MessageCatalogKey<TMessageCatalog>;
    item: MessageCatalogValue<TMessageCatalog, MessageCatalogKey<TMessageCatalog>>;
    attempt?: number;
    availableAt?: Date;
    visibilityTimeoutMs: number;
  }): Promise<boolean> {
    if (!id) {
      throw new Error("enqueueOnce requires an id");
    }
    try {
      const score = availableAt ? availableAt.getTime() : Date.now();
      const deduplicationKey = nanoid();
      const serializedItem = JSON.stringify({
        job,
        item,
        visibilityTimeoutMs,
        attempt,
        deduplicationKey,
      });
      const result = await this.redis.enqueueItemOnce(`queue`, `items`, id, score, serializedItem);
      // 1 if inserted, 0 if already exists
      return result === 1;
    } catch (e) {
      this.logger.error(`SimpleQueue ${this.name}.enqueueOnce(): error enqueuing`, {
        queue: this.name,
        error: e,
        id,
        item,
      });
      throw e;
    }
  }

  async dequeue(count: number = 1): Promise<Array<QueueItem<TMessageCatalog>>> {
    const now = Date.now();

    try {
      const results = await this.redis.dequeueItems(`queue`, `items`, now, count);

      if (!results || results.length === 0) {
        return [];
      }

      const dequeuedItems: Array<QueueItem<TMessageCatalog>> = [];

      for (const [id, serializedItem, score] of results) {
        const parsedItem = JSON.parse(serializedItem) as any;
        if (typeof parsedItem.job !== "string") {
          this.logger.error(`Invalid item in queue`, { queue: this.name, id, item: parsedItem });
          continue;
        }

        const timestamp = new Date(Number(score));

        const schema = this.schema[parsedItem.job];

        if (!schema) {
          this.logger.error(`Invalid item in queue, schema not found`, {
            queue: this.name,
            id,
            item: parsedItem,
            job: parsedItem.job,
            timestamp,
          });
          continue;
        }

        const validatedItem = schema.safeParse(parsedItem.item);

        if (!validatedItem.success) {
          this.logger.error("Invalid item in queue", {
            queue: this.name,
            id,
            item: parsedItem,
            errors: validatedItem.error,
            attempt: parsedItem.attempt,
            timestamp,
          });
          continue;
        }

        const visibilityTimeoutMs = parsedItem.visibilityTimeoutMs as number;

        dequeuedItems.push({
          id,
          job: parsedItem.job,
          item: validatedItem.data,
          visibilityTimeoutMs,
          attempt: parsedItem.attempt ?? 0,
          timestamp,
          deduplicationKey: parsedItem.deduplicationKey,
        });
      }

      return dequeuedItems;
    } catch (e) {
      this.logger.error(`SimpleQueue ${this.name}.dequeue(): error dequeuing`, {
        queue: this.name,
        error: e,
        count,
      });
      throw e;
    }
  }

  async ack(id: string, deduplicationKey?: string): Promise<void> {
    try {
      const result = await this.redis.ackItem(`queue`, `items`, id, deduplicationKey ?? "");
      if (result !== 1) {
        this.logger.debug(
          `SimpleQueue ${this.name}.ack(): ack operation returned ${result}. This means it was not removed from the queue.`,
          {
            queue: this.name,
            id,
            deduplicationKey,
            result,
          }
        );
      }
    } catch (e) {
      this.logger.error(`SimpleQueue ${this.name}.ack(): error acknowledging item`, {
        queue: this.name,
        error: e,
        id,
        deduplicationKey,
      });
      throw e;
    }
  }

  async reschedule(id: string, availableAt: Date): Promise<void> {
    await this.redis.zadd(`queue`, "XX", availableAt.getTime(), id);
  }

  async size({ includeFuture = false }: { includeFuture?: boolean } = {}): Promise<number> {
    try {
      if (includeFuture) {
        // If includeFuture is true, return the total count of all items
        return await this.redis.zcard(`queue`);
      } else {
        // If includeFuture is false, return the count of items available now
        const now = Date.now();
        return await this.redis.zcount(`queue`, "-inf", now);
      }
    } catch (e) {
      this.logger.error(`SimpleQueue ${this.name}.size(): error getting queue size`, {
        queue: this.name,
        error: e,
        includeFuture,
      });
      throw e;
    }
  }

  async moveToDeadLetterQueue(id: string, errorMessage: string): Promise<void> {
    try {
      const result = await this.redis.moveToDeadLetterQueue(
        `queue`,
        `items`,
        `dlq`,
        `dlq:items`,
        id,
        errorMessage
      );

      if (result !== 1) {
        throw new Error("Move to Dead Letter Queue operation failed");
      }
    } catch (e) {
      this.logger.error(
        `SimpleQueue ${this.name}.moveToDeadLetterQueue(): error moving item to DLQ`,
        {
          queue: this.name,
          error: e,
          id,
          errorMessage,
        }
      );
      throw e;
    }
  }

  async sizeOfDeadLetterQueue(): Promise<number> {
    try {
      return await this.redis.zcard(`dlq`);
    } catch (e) {
      this.logger.error(`SimpleQueue ${this.name}.dlqSize(): error getting DLQ size`, {
        queue: this.name,
        error: e,
      });
      throw e;
    }
  }

  async redriveFromDeadLetterQueue(id: string): Promise<void> {
    try {
      const result = await this.redis.redriveFromDeadLetterQueue(
        `queue`,
        `items`,
        `dlq`,
        `dlq:items`,
        id
      );

      if (result !== 1) {
        throw new Error("Redrive from Dead Letter Queue operation failed");
      }
    } catch (e) {
      this.logger.error(
        `SimpleQueue ${this.name}.redriveFromDeadLetterQueue(): error redriving item from DLQ`,
        {
          queue: this.name,
          error: e,
          id,
        }
      );
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  #registerCommands() {
    this.redis.defineCommand("enqueueItem", {
      numberOfKeys: 2,
      lua: `
        local queue = KEYS[1]
        local items = KEYS[2]
        local id = ARGV[1]
        local score = ARGV[2]
        local serializedItem = ARGV[3]

        redis.call('ZADD', queue, score, id)
        redis.call('HSET', items, id, serializedItem)

        return 1
      `,
    });

    this.redis.defineCommand("dequeueItems", {
      numberOfKeys: 2,
      lua: `
        local queue = KEYS[1]
        local items = KEYS[2]
        local now = tonumber(ARGV[1])
        local count = tonumber(ARGV[2])

        local result = redis.call('ZRANGEBYSCORE', queue, '-inf', now, 'WITHSCORES', 'LIMIT', 0, count)

        if #result == 0 then
          return {}
        end

        local dequeued = {}

        for i = 1, #result, 2 do
          local id = result[i]
          local score = tonumber(result[i + 1])

          if score > now then
            break
          end

          local serializedItem = redis.call('HGET', items, id)

          if serializedItem then
            local item = cjson.decode(serializedItem)
            local visibilityTimeoutMs = tonumber(item.visibilityTimeoutMs)
            local invisibleUntil = now + visibilityTimeoutMs

            redis.call('ZADD', queue, invisibleUntil, id)
            table.insert(dequeued, {id, serializedItem, score})
          else
            -- Remove the orphaned queue entry if no corresponding item exists
            redis.call('ZREM', queue, id)
          end
        end

        return dequeued
      `,
    });

    this.redis.defineCommand("ackItem", {
      numberOfKeys: 2,
      lua: `
        local queueKey = KEYS[1]
        local itemsKey = KEYS[2]
        local id = ARGV[1]
        local deduplicationKey = ARGV[2]

        -- Get the item from the hash
        local item = redis.call('HGET', itemsKey, id)
        if not item then
          return -1
        end

        -- Only check deduplicationKey if a non-empty one was passed in
        if deduplicationKey and deduplicationKey ~= "" then
          local success, parsed = pcall(cjson.decode, item)
          if success then
            if parsed.deduplicationKey and parsed.deduplicationKey ~= deduplicationKey then
              return 0
            end
          end
        end

        -- Remove from sorted set and hash
        redis.call('ZREM', queueKey, id)
        redis.call('HDEL', itemsKey, id)
        return 1
      `,
    });

    this.redis.defineCommand("moveToDeadLetterQueue", {
      numberOfKeys: 4,
      lua: `
        local queue = KEYS[1]
        local items = KEYS[2]
        local dlq = KEYS[3]
        local dlqItems = KEYS[4]
        local id = ARGV[1]
        local errorMessage = ARGV[2]

        local item = redis.call('HGET', items, id)
        if not item then
          return 0
        end

        local parsedItem = cjson.decode(item)
        parsedItem.errorMessage = errorMessage

        local time = redis.call('TIME')
        local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

        redis.call('ZREM', queue, id)
        redis.call('HDEL', items, id)

        redis.call('ZADD', dlq, now, id)
        redis.call('HSET', dlqItems, id, cjson.encode(parsedItem))

        return 1
      `,
    });

    this.redis.defineCommand("redriveFromDeadLetterQueue", {
      numberOfKeys: 4,
      lua: `
        local queue = KEYS[1]
        local items = KEYS[2]
        local dlq = KEYS[3]
        local dlqItems = KEYS[4]
        local id = ARGV[1]

        local item = redis.call('HGET', dlqItems, id)
        if not item then
          return 0
        end

        local parsedItem = cjson.decode(item)
        parsedItem.errorMessage = nil

        local time = redis.call('TIME')
        local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

        redis.call('ZREM', dlq, id)
        redis.call('HDEL', dlqItems, id)

        redis.call('ZADD', queue, now, id)
        redis.call('HSET', items, id, cjson.encode(parsedItem))

        return 1
      `,
    });

    this.redis.defineCommand("enqueueItemOnce", {
      numberOfKeys: 2,
      lua: `
        local queue = KEYS[1]
        local items = KEYS[2]
        local id = ARGV[1]
        local score = ARGV[2]
        local serializedItem = ARGV[3]

        -- Only add if not exists
        local added = redis.call('HSETNX', items, id, serializedItem)
        if added == 1 then
          redis.call('ZADD', queue, 'NX', score, id)
          return 1
        else
          return 0
        end
      `,
    });
  }
}

declare module "@internal/redis" {
  interface RedisCommander<Context> {
    enqueueItem(
      //keys
      queue: string,
      items: string,
      //args
      id: string,
      score: number,
      serializedItem: string,
      callback?: Callback<number>
    ): Result<number, Context>;

    dequeueItems(
      //keys
      queue: string,
      items: string,
      //args
      now: number,
      count: number,
      callback?: Callback<Array<[string, string, string]>>
    ): Result<Array<[string, string, string]>, Context>;

    ackItem(
      queue: string,
      items: string,
      id: string,
      deduplicationKey: string,
      callback?: Callback<number>
    ): Result<number, Context>;

    redriveFromDeadLetterQueue(
      queue: string,
      items: string,
      dlq: string,
      dlqItems: string,
      id: string,
      callback?: Callback<number>
    ): Result<number, Context>;

    moveToDeadLetterQueue(
      queue: string,
      items: string,
      dlq: string,
      dlqItems: string,
      id: string,
      errorMessage: string,
      callback?: Callback<number>
    ): Result<number, Context>;

    enqueueItemOnce(
      queue: string,
      items: string,
      id: string,
      score: number,
      serializedItem: string,
      callback?: Callback<number>
    ): Result<number, Context>;
  }
}
