import { Logger } from "@trigger.dev/core/logger";
import Redis, { type Callback, type RedisOptions, type Result } from "ioredis";
import { z } from "zod";

export interface MessageCatalogSchema {
  [key: string]: z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>;
}

export type MessageCatalogKey<TMessageCatalog extends MessageCatalogSchema> = keyof TMessageCatalog;
export type MessageCatalogValue<
  TMessageCatalog extends MessageCatalogSchema,
  TKey extends MessageCatalogKey<TMessageCatalog>,
> = z.infer<TMessageCatalog[TKey]>;

export class MessageQueue<TMessageCatalog extends MessageCatalogSchema> {
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
    this.redis = new Redis({
      ...redisOptions,
      keyPrefix: `{fifoqueue:${name}:}`,
      retryStrategy(times) {
        const delay = Math.min(times * 50, 1000);
        return delay;
      },
      maxRetriesPerRequest: 3,
    });
    this.#registerCommands();
    this.schema = schema;

    this.logger = logger ?? new Logger("SimpleQueue", "debug");

    this.redis.on("error", (error) => {
      this.logger.error(`Redis Error for fifo queue ${this.name}:`, { queue: this.name, error });
    });

    this.redis.on("connect", () => {
      this.logger.log(`Redis connected for fifo queue ${this.name}`);
    });

    this.redis.on("reconnecting", () => {
      this.logger.warn(`Redis reconnecting for fifo queue ${this.name}`);
    });

    this.redis.on("close", () => {
      this.logger.warn(`Redis connection closed for fifo queue ${this.name}`);
    });
  }

  async publish({
    key,
    valueType,
    value,
    attempt = 0,
    visibilityTimeoutMs = 10_000,
  }: {
    key: string;
    valueType: MessageCatalogKey<TMessageCatalog>;
    value: MessageCatalogValue<TMessageCatalog, MessageCatalogKey<TMessageCatalog>>;
    attempt?: number;
    visibilityTimeoutMs?: number;
  }): Promise<void> {
    try {
      const serializedValue = JSON.stringify({ value, valueType, attempt, visibilityTimeoutMs });

      const result = await this.redis.rpush(key, serializedValue);
      if (result <= 0) {
        throw new Error("publish operation failed");
      }
    } catch (e) {
      this.logger.error(`MessageQueue ${this.name}.enqueue(): error enqueuing`, {
        queue: this.name,
        error: e,
        key,
        valueType,
        value,
        attempt,
      });
      throw e;
    }
  }

  /**
  Consume messages with the passed in keys.
  This will hold a connection open up until the timeout (in seconds) if there are no messages yet.
  If the message isn't confirmed to have been read in the visibility timeout, it will be reattempted.
  */
  async consume({
    keys,
    timeout = 10,
    count = 10,
  }: {
    keys: string[];
    timeout?: number;
    count?: number;
  }): Promise<
    Array<{
      key: string;
      valueType: MessageCatalogKey<TMessageCatalog>;
      value: MessageCatalogValue<TMessageCatalog, MessageCatalogKey<TMessageCatalog>>;
      visibilityTimeoutMs: number;
      attempt: number;
    }>
  > {
    try {
      const results = await this.redis.dequeueItems(keys.length, ...keys, timeout, count);
      const parsed = JSON.parse(results);

      const dequeuedItems = [];

      for (const [key, serializedItem] of parsed) {
        const parsedItem = JSON.parse(serializedItem);
        if (typeof parsedItem.valueType !== "string") {
          this.logger.error(`Invalid item in queue`, { queue: this.name, key, item: parsedItem });
          continue;
        }

        const schema = this.schema[parsedItem.valueType];

        if (!schema) {
          this.logger.error(`Invalid item in queue, schema not found`, {
            queue: this.name,
            key,
            item: parsedItem,
          });
          continue;
        }

        const validatedItem = schema.safeParse(parsedItem.item);

        if (!validatedItem.success) {
          this.logger.error("Invalid item in queue", {
            queue: this.name,
            id: key,
            item: parsedItem,
            errors: validatedItem.error,
            attempt: parsedItem.attempt,
          });
          continue;
        }

        const visibilityTimeoutMs = parsedItem.visibilityTimeoutMs as number;
        // const invisibleUntil = now + visibilityTimeoutMs;

        // await this.redis.zadd(`queue`, invisibleUntil, id);

        dequeuedItems.push({
          key,
          valueType: parsedItem.valueType,
          value: validatedItem.data,
          visibilityTimeoutMs,
          attempt: parsedItem.attempt ?? 0,
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

  async ack(id: string): Promise<void> {
    try {
      await this.redis.ackItem(`queue`, `items`, id);
    } catch (e) {
      this.logger.error(`SimpleQueue ${this.name}.ack(): error acknowledging item`, {
        queue: this.name,
        error: e,
        id,
      });
      throw e;
    }
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
    this.redis.defineCommand("dequeueItems", {
      numberOfKeys: 0,
      lua: `
        local numKeys = tonumber(ARGV[1])
        local keys = {}
        for i = 2, numKeys + 1 do
          table.insert(keys, ARGV[i])
        end
        local timeout = tonumber(ARGV[numKeys + 2])
        local count = tonumber(ARGV[numKeys + 3])

        local result = redis.call('BLMPOP', timeout, numKeys, unpack(keys), 'LEFT', 'COUNT', count)

        if not result then
          return '[]'
        end

        local key = result[1]
        local items = result[2]
        local dequeued = {}

        for i = 1, #items do
          table.insert(dequeued, {key, items[i]})
        end

        return cjson.encode(dequeued)
      `,
    });

    this.redis.defineCommand("ackItem", {
      numberOfKeys: 2,
      lua: `
        local queue = KEYS[1]
        local items = KEYS[2]
        local id = ARGV[1]

        redis.call('ZREM', queue, id)
        redis.call('HDEL', items, id)

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

        redis.call('ZREM', queue, id)
        redis.call('HDEL', items, id)

        redis.call('ZADD', dlq, redis.call('TIME')[1], id)
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

        redis.call('ZREM', dlq, id)
        redis.call('HDEL', dlqItems, id)

        redis.call('ZADD', queue, redis.call('TIME')[1], id)
        redis.call('HSET', items, id, cjson.encode(parsedItem))

        return 1
      `,
    });
  }
}

declare module "ioredis" {
  interface RedisCommander<Context> {
    dequeueItems(
      numKeys: number,
      ...args: [...keys: string[], timeout: number, count: number]
    ): Result<string, Context>;

    ackItem(
      queue: string,
      items: string,
      id: string,
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
  }
}
