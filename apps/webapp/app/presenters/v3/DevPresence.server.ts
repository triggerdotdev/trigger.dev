import Redis, { type RedisOptions } from "ioredis";
import { defaultReconnectOnError } from "@internal/redis";
import { env } from "~/env.server";
import { subDays } from "date-fns";

const DEV_RECENT_DEBOUNCE_SEC = 60;
const DEV_RECENT_TTL = 7 * 24 * 60 * 60; // 7 days
const RECENCY_DAYS = 3;

export class DevPresence {
  private redis: Redis;

  constructor(options: RedisOptions) {
    this.redis = new Redis({ reconnectOnError: defaultReconnectOnError, ...options });
  }

  async isConnected(environmentId: string) {
    const presenceKey = this.getPresenceKey(environmentId);
    const presenceValue = await this.redis.get(presenceKey);
    return !!presenceValue;
  }

  async isConnectedMany(environmentIds: string[]): Promise<Map<string, boolean>> {
    if (environmentIds.length === 0) return new Map();
    const keys = environmentIds.map((id) => this.getPresenceKey(id));
    const values = await this.redis.mget(keys);
    return new Map(environmentIds.map((id, i) => [id, !!values[i]]));
  }

  async setConnected({ userId, projectId, environmentId, ttl }: { userId: string; projectId: string; environmentId: string; ttl: number; }) {
    const presenceKey = this.getPresenceKey(environmentId);
    await this.redis.setex(presenceKey, ttl, new Date().toISOString());

    const touchKey = this.getTouchKey(environmentId);
    const acquired = await this.redis.set(touchKey, "1", "EX", DEV_RECENT_DEBOUNCE_SEC, "NX");

    if (acquired !== null) {
      const recentKey = this.getRecentKey(userId, projectId);
      const now = new Date();
      const threeDaysAgo = subDays(now, RECENCY_DAYS);
      await this.redis.zadd(recentKey, now.getTime(), environmentId);
      await this.redis.zremrangebyscore(recentKey, 0, threeDaysAgo.getTime());
      await this.redis.zremrangebyrank(recentKey, 0, -51);
      await this.redis.expire(recentKey, DEV_RECENT_TTL);
    }
  }

  async getRecentBranchIds(userId: string, projectId: string) {
    const recentKey = this.getRecentKey(userId, projectId);
    const threeDaysAgo = subDays(Date.now(), RECENCY_DAYS);
    const raw = await this.redis.zrevrangebyscore(recentKey, "+inf", threeDaysAgo.getTime(), "WITHSCORES");

    const branches = new Map<string, Date>();
    for (let i = 0; i < raw.length; i += 2) {
      branches.set(raw[i], new Date(Number(raw[i + 1])));
    }
    return branches;
  }

  private getPresenceKey(environmentId: string) {
    return `dev-presence:connection:${environmentId}`;
  }

  private getRecentKey(userId: string, projectId: string) {
    return `dev-recent:${userId}:${projectId}`;
  }

  private getTouchKey(environmentId: string) {
    return `dev-recent-touch:${environmentId}`;
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
