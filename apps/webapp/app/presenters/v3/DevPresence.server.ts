import Redis, { type RedisOptions } from "ioredis";
import { env } from "~/env.server";

const PRESENCE_KEY_PREFIX = "dev-presence:connection:";

export class DevPresence {
  private redis: Redis;

  constructor(options: RedisOptions) {
    this.redis = new Redis({
      ...options,
      family: 0, // Support both IPv4 and IPv6 (Railway internal DNS)
    });
  }

  async isConnected(environmentId: string) {
    const presenceKey = this.getPresenceKey(environmentId);
    const presenceValue = await this.redis.get(presenceKey);
    return !!presenceValue;
  }

  async setConnected(environmentId: string, ttl: number) {
    const presenceKey = this.getPresenceKey(environmentId);
    await this.redis.setex(presenceKey, ttl, new Date().toISOString());
  }

  private getPresenceKey(environmentId: string) {
    return `${PRESENCE_KEY_PREFIX}${environmentId}`;
  }
}

export const devPresence = new DevPresence({
  port: env.RUN_ENGINE_DEV_PRESENCE_REDIS_PORT ?? undefined,
  host: env.RUN_ENGINE_DEV_PRESENCE_REDIS_HOST ?? undefined,
  username: env.RUN_ENGINE_DEV_PRESENCE_REDIS_USERNAME ?? undefined,
  password: env.RUN_ENGINE_DEV_PRESENCE_REDIS_PASSWORD ?? undefined,
  enableAutoPipelining: true,
  ...(env.RUN_ENGINE_DEV_PRESENCE_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
});
