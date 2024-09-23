import Redis, { RedisOptions } from "ioredis";
import { z } from "zod";
import { Logger } from "@trigger.dev/core/logger";

export class SimpleQueue<T extends z.ZodType> {
  name: string;
  private redis: Redis;
  private schema: T;
  private logger: Logger;

  constructor(name: string, schema: T, redisOptions: RedisOptions, logger?: Logger) {
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

      const result = await this.redis
        .multi()
        .zadd(`queue`, score, id)
        .hset(`items`, id, serializedItem)
        .exec();

      if (!result) {
        throw new Error("Redis multi command returned null");
      }

      result.forEach((res, index) => {
        if (res[0]) {
          throw new Error(`Redis operation ${index} failed: ${res[0]}`);
        }
      });
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
      const result = await this.redis
        .multi()
        .zrangebyscore(`queue`, "-inf", now, "WITHSCORES", "LIMIT", 0, 1)
        .exec();

      if (!result) {
        throw new Error("Redis multi command returned null");
      }

      result.forEach((res, index) => {
        if (res[0]) {
          throw new Error(`Redis operation ${index} failed: ${res[0]}`);
        }
      });

      if (!result[0][1] || (result[0][1] as string[]).length === 0) {
        return null;
      }

      const [id, score] = result[0][1] as string[];

      // Check if the item is available now
      if (parseInt(score) > now) {
        return null;
      }

      // Remove the item from the sorted set
      await this.redis.zrem(`queue`, id);

      const serializedItem = await this.redis.hget(`items`, id);

      if (!serializedItem) {
        this.logger.warn(`Item ${id} not found in hash, might have been deleted`, {
          queue: this.name,
          id,
        });
        return null;
      }

      await this.redis.hdel(`items`, id);
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
}
