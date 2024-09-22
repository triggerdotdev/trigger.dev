import Redis, { RedisOptions } from "ioredis";
import { z } from "zod";

class SimpleQueue<T extends z.ZodType> {
  private redis: Redis;
  private keyPrefix: string;
  private schema: T;

  constructor(name: string, schema: T, redisOptions: RedisOptions) {
    this.redis = new Redis(redisOptions);
    this.keyPrefix = `queue:${name}:`;
    this.schema = schema;
  }

  async enqueue(id: string, item: z.infer<T>, availableAt?: Date): Promise<void> {
    const score = availableAt ? availableAt.getTime() : Date.now();
    const serializedItem = JSON.stringify(item);

    await this.redis
      .multi()
      .zadd(`${this.keyPrefix}queue`, score, id)
      .hset(`${this.keyPrefix}items`, id, serializedItem)
      .exec();
  }

  async dequeue(): Promise<{ id: string; item: z.infer<T> } | null> {
    const now = Date.now();

    const result = await this.redis
      .multi()
      .zrangebyscore(`${this.keyPrefix}queue`, "-inf", now, "LIMIT", 0, 1)
      .zremrangebyrank(`${this.keyPrefix}queue`, 0, 0)
      .exec();

    if (!result || !result[0][1] || (result[0][1] as string[]).length === 0) {
      return null;
    }

    const id = (result[0][1] as string[])[0];
    const serializedItem = await this.redis.hget(`${this.keyPrefix}items`, id);

    if (serializedItem) {
      await this.redis.hdel(`${this.keyPrefix}items`, id);
      const parsedItem = JSON.parse(serializedItem);
      const validatedItem = this.schema.parse(parsedItem);
      return { id, item: validatedItem };
    }

    return null;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

export default SimpleQueue;
