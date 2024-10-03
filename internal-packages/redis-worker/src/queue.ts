import { Logger } from "@trigger.dev/core/logger";
import Redis, { type Callback, type RedisOptions, type Result } from "ioredis";
import { z } from "zod";

export class SimpleQueue<T extends z.ZodType> {
  name: string;
  private redis: Redis;
  private schema: T;
  private logger: Logger;

  constructor({
    name,
    schema,
    redisOptions,
    logger,
  }: {
    name: string;
    schema: T;
    redisOptions: RedisOptions;
    logger?: Logger;
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
      // this.logger.log(`Redis connected for queue ${this.name}`);
    });
  }

  async enqueue(id: string, item: z.infer<T>, availableAt?: Date): Promise<void> {
    try {
      const score = availableAt ? availableAt.getTime() : Date.now();
      const serializedItem = JSON.stringify(item);

      const result = await this.redis.enqueueItem(`queue`, `items`, id, score, serializedItem);

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

  async dequeue(): Promise<{ id: string; item: z.infer<T> } | null> {
    const now = Date.now();

    try {
      const result = await this.redis.dequeueItem(`queue`, `items`, now);

      if (!result) {
        return null;
      }

      const [id, serializedItem] = result;

      const parsedItem = JSON.parse(serializedItem);
      const validatedItem = this.schema.safeParse(parsedItem);

      if (!validatedItem.success) {
        this.logger.error("Invalid item in queue", {
          queue: this.name,
          id,
          item: parsedItem,
          errors: validatedItem.error,
        });
        return null;
      }

      return { id, item: validatedItem.data };
    } catch (e) {
      this.logger.error(`SimpleQueue ${this.name}.dequeue(): error dequeuing`, {
        queue: this.name,
        error: e,
      });
      throw e;
    }
  }

  async size(): Promise<number> {
    try {
      const result = await this.redis.zcard(`queue`);
      return result;
    } catch (e) {
      this.logger.error(`SimpleQueue ${this.name}.size(): error getting queue size`, {
        queue: this.name,
        error: e,
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

    this.redis.defineCommand("dequeueItem", {
      numberOfKeys: 2,
      lua: `
          local queue = KEYS[1]
          local items = KEYS[2]
          local now = tonumber(ARGV[1])

          local result = redis.call('ZRANGEBYSCORE', queue, '-inf', now, 'WITHSCORES', 'LIMIT', 0, 1)

          if #result == 0 then
            return nil
          end

          local id = result[1]
          local score = tonumber(result[2])

          if score > now then
            return nil
          end

          redis.call('ZREM', queue, id)

          local serializedItem = redis.call('HGET', items, id)

          if not serializedItem then
            return nil
          end

          redis.call('HDEL', items, id)

          return {id, serializedItem}
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

    dequeueItem(
      //keys
      queue: string,
      items: string,
      //args
      now: number,
      callback?: Callback<[string, string] | null>
    ): Result<[string, string] | null, Context>;
  }
}
