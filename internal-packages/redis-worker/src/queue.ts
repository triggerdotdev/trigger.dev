import { Logger } from "@trigger.dev/core/logger";
import Redis, { type Callback, type RedisOptions, type Result } from "ioredis";
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
    shutdownTimeMs?: number;
  }) {
    this.name = name;
    this.redis = new Redis({
      ...redisOptions,
      keyPrefix: `queue:${name}:`,
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
      this.logger.error(`Redis Error for queue ${this.name}:`, { queue: this.name, error });
    });

    this.redis.on("connect", () => {
      this.logger.log(`Redis connected for queue ${this.name}`);
    });

    this.redis.on("reconnecting", () => {
      this.logger.warn(`Redis reconnecting for queue ${this.name}`);
    });

    this.redis.on("close", () => {
      this.logger.warn(`Redis connection closed for queue ${this.name}`);
    });
  }

  async enqueue({
    id,
    job,
    item,
    availableAt,
    visibilityTimeoutMs,
  }: {
    id?: string;
    job: MessageCatalogKey<TMessageCatalog>;
    item: MessageCatalogValue<TMessageCatalog, MessageCatalogKey<TMessageCatalog>>;
    availableAt?: Date;
    visibilityTimeoutMs: number;
  }): Promise<void> {
    try {
      const score = availableAt ? availableAt.getTime() : Date.now();
      const serializedItem = JSON.stringify({
        job,
        item,
        visibilityTimeoutMs,
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
  async dequeue(count: number = 1): Promise<
    Array<{
      id: string;
      job: MessageCatalogKey<TMessageCatalog>;
      item: MessageCatalogValue<TMessageCatalog, MessageCatalogKey<TMessageCatalog>>;
      visibilityTimeoutMs: number;
    }>
  > {
    const now = Date.now();

    try {
      const results = await this.redis.dequeueItems(`queue`, `items`, now, count);

      if (!results || results.length === 0) {
        return [];
      }

      const dequeuedItems = [];

      for (const [id, serializedItem] of results) {
        const parsedItem = JSON.parse(serializedItem);
        if (typeof parsedItem.job !== "string") {
          this.logger.error(`Invalid item in queue`, { queue: this.name, id, item: parsedItem });
          continue;
        }

        const schema = this.schema[parsedItem.job];

        if (!schema) {
          this.logger.error(`Invalid item in queue, schema not found`, {
            queue: this.name,
            id,
            item: parsedItem,
            job: parsedItem.job,
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
          });
          continue;
        }

        const visibilityTimeoutMs = parsedItem.visibilityTimeoutMs as number;
        const invisibleUntil = now + visibilityTimeoutMs;

        await this.redis.zadd(`queue`, invisibleUntil, id);

        dequeuedItems.push({
          id,
          job: parsedItem.job,
          item: validatedItem.data,
          visibilityTimeoutMs,
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
            table.insert(dequeued, {id, serializedItem})
          end
        end

        return dequeued
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
  }
}

declare module "ioredis" {
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
      callback?: Callback<Array<[string, string]>>
    ): Result<Array<[string, string]>, Context>;

    ackItem(
      queue: string,
      items: string,
      id: string,
      callback?: Callback<number>
    ): Result<number, Context>;
  }
}
