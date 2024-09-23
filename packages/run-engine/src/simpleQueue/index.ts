import Redis, { RedisOptions } from "ioredis";
import { z } from "zod";

export class SimpleQueue<T extends z.ZodType> {
  name: string;
  private redis: Redis;
  private schema: T;

  constructor(name: string, schema: T, redisOptions: RedisOptions) {
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

    this.redis.on("error", (error) => {
      console.error(`Redis Error for queue ${this.name}:`, error);
    });

    this.redis.on("connect", () => {
      // console.log(`Redis connected for queue ${this.name}`);
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
      console.error(`SimpleQueue ${this.name}.enqueue(): error enqueuing`, {
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
        console.warn(`Item ${id} not found in hash, might have been deleted`);
        return null;
      }

      await this.redis.hdel(`items`, id);
      const parsedItem = JSON.parse(serializedItem);
      const validatedItem = this.schema.safeParse(parsedItem);

      if (!validatedItem.success) {
        console.error("Invalid item in queue", {
          id,
          item: parsedItem,
          errors: validatedItem.error,
        });
        return null;
      }

      return { id, item: validatedItem.data };
    } catch (e) {
      console.error(`SimpleQueue ${this.name}.dequeue(): error dequeuing`, { error: e });
      throw e;
    }
  }

  async size(): Promise<number> {
    try {
      const result = await this.redis.zcard(`queue`);
      return result;
    } catch (e) {
      console.error(`SimpleQueue ${this.name}.size(): error getting queue size`, { error: e });
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
