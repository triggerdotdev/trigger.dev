import type { CacheService } from "internal-integrations";
import { redis } from "./redis.server";

export class RedisCacheService implements CacheService {
  constructor(private readonly namespace: string) {}

  async get(key: string) {
    return redis.get(`${this.namespace}:${key}`);
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl) {
      await redis.set(`${this.namespace}:${key}`, value, "EX", ttl);
    } else {
      await redis.set(`${this.namespace}:${key}`, value);
    }
  }
}
