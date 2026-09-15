import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import { Logger } from "@trigger.dev/core/logger";

export type CachedRedisValueOptions<T> = {
  redis: RedisOptions;
  key: string;
  parse: (raw: string | null) => T;
  defaultValue: T;
  cacheTtlMs?: number;
  logger?: Logger;
  loggerName?: string;
};

// Reads a Redis key with a short stale-while-revalidate cache and a synchronous getter for
// hot paths. Warms eagerly on construction; concurrent refreshes dedupe onto one GET so an
// awaited refresh always resolves to a completed read.
export class CachedRedisValue<T> {
  private readonly redis: Redis;
  private readonly key: string;
  private readonly parse: (raw: string | null) => T;
  private readonly cacheTtlMs: number;
  private readonly logger: Logger;
  private value: T;
  private lastFetchedAt = 0;
  private refreshPromise?: Promise<T>;

  constructor(options: CachedRedisValueOptions<T>) {
    this.logger = options.logger ?? new Logger(options.loggerName ?? "CachedRedisValue", "warn");
    this.redis = createRedisClient(
      { ...options.redis, keyPrefix: undefined },
      {
        onError: (error) =>
          this.logger.error("cached value redis error", { error, key: options.key }),
      }
    );
    this.key = options.key;
    this.parse = options.parse;
    this.cacheTtlMs = options.cacheTtlMs ?? 10_000;
    this.value = options.defaultValue;
    void this.refresh();
  }

  get(): T {
    if (Date.now() - this.lastFetchedAt > this.cacheTtlMs) {
      void this.refresh();
    }
    return this.value;
  }

  async refresh(): Promise<T> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.#doRefresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  async #doRefresh(): Promise<T> {
    try {
      this.value = this.parse(await this.redis.get(this.key));
    } catch (error) {
      this.logger.debug("cached value refresh failed, keeping cached value", {
        error,
        key: this.key,
      });
    } finally {
      this.lastFetchedAt = Date.now();
    }
    return this.value;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

export type CachedRedisNumberOptions = {
  redis: RedisOptions;
  key: string;
  defaultValue: number;
  min?: number;
  max?: number;
  cacheTtlMs?: number;
  logger?: Logger;
};

// Live-tunable numeric value, clamped to [min,max]; falls back to defaultValue on a
// missing/unparseable key. Exposes a synchronous value() for hot paths.
export class CachedRedisNumber {
  private readonly inner: CachedRedisValue<number>;

  constructor(options: CachedRedisNumberOptions) {
    const min = options.min ?? Number.NEGATIVE_INFINITY;
    const max = options.max ?? Number.POSITIVE_INFINITY;
    const clamp = (n: number) => Math.min(max, Math.max(min, n));
    const fallback = clamp(options.defaultValue);
    this.inner = new CachedRedisValue<number>({
      redis: options.redis,
      key: options.key,
      parse: (raw) => {
        // Number("") is 0 (not NaN), so treat blank/whitespace as missing => fallback.
        const n = raw == null || raw.trim() === "" ? Number.NaN : Number(raw);
        return Number.isFinite(n) ? clamp(n) : fallback;
      },
      defaultValue: fallback,
      cacheTtlMs: options.cacheTtlMs,
      logger: options.logger,
      loggerName: "CachedRedisNumber",
    });
  }

  value(): number {
    return this.inner.get();
  }

  refresh(): Promise<number> {
    return this.inner.refresh();
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
