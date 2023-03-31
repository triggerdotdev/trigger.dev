import type { CacheService } from "@trigger.dev/integration-sdk";

export class RedisCacheService implements CacheService {
  constructor(private readonly namespace: string) {}

  async get(key: string) {
    return null;
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    // if (ttl) {
    //   await redis.set(`${this.namespace}:${key}`, value, "EX", ttl);
    // } else {
    //   await redis.set(`${this.namespace}:${key}`, value);
    // }
  }
}
