import type { RedisOptions } from "@internal/redis";
import type { Logger } from "@trigger.dev/core/logger";
import { CachedRedisValue } from "./cachedValue.js";

export type CachedRedisFlagOptions = {
  redis: RedisOptions;
  /** Redis key holding the flag. A value of "1"/"true"/"on"/"enabled" is truthy. */
  key: string;
  cacheTtlMs?: number;
  defaultValue?: boolean;
  logger?: Logger;
};

const TRUTHY = new Set(["1", "true", "on", "enabled", "yes"]);

/**
 * Boolean feature flag from a Redis key with a short stale-while-revalidate cache,
 * exposing a synchronous getter for hot paths (building Lua ARGV on every op).
 */
export class CachedRedisFlag {
  private readonly inner: CachedRedisValue<boolean>;

  constructor(options: CachedRedisFlagOptions) {
    this.inner = new CachedRedisValue<boolean>({
      redis: options.redis,
      key: options.key,
      parse: (raw) => raw != null && TRUTHY.has(raw.trim().toLowerCase()),
      defaultValue: options.defaultValue ?? false,
      cacheTtlMs: options.cacheTtlMs,
      logger: options.logger,
      loggerName: "CachedRedisFlag",
    });
  }

  enabled(): boolean {
    return this.inner.get();
  }

  refresh(): Promise<boolean> {
    return this.inner.refresh();
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}
