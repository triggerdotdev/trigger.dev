import { createRedisClient, type RedisClient, type RedisWithClusterOptions } from "~/redis.server";
import { logger } from "../logger.server";
import { BoundedTtlCache } from "./boundedTtlCache";

/**
 * Per-connection replay cursors ("when did this connection last receive data"), keyed by the
 * env-prefixed working-set key. Sharing them fleet-wide makes an instance hop look like a normal
 * inter-poll gap instead of an unknown one, so hops stop triggering cold resolves and full-window
 * replays. Values are single timestamps, so the shared store stays cheap.
 */
export interface ReplayCursorStore {
  /** The connection's last-response timestamp; undefined on miss OR error (the caller
   * degrades to a cold probe / full-window replay, never blocks the poll). */
  get(key: string): Promise<number | undefined>;
  /** Fire-and-forget stamp; must never throw. */
  set(key: string, ms: number): void;
}

/** Per-instance fallback with the same shape (used when the shared store is disabled, and in tests). */
export class InMemoryReplayCursorStore implements ReplayCursorStore {
  readonly #cache: BoundedTtlCache<number>;

  constructor(ttlMs: number, maxEntries: number) {
    this.#cache = new BoundedTtlCache<number>(ttlMs, maxEntries);
  }

  async get(key: string): Promise<number | undefined> {
    return this.#cache.get(key);
  }

  set(key: string, ms: number): void {
    this.#cache.set(key, ms);
  }
}

export type RedisReplayCursorStoreOptions = {
  redis: RedisWithClusterOptions;
  /** Entry TTL (ms); matches the working-set TTL so both views of a connection age out together. */
  ttlMs: number;
  /** Read deadline (ms): a slow or down Redis degrades the poll to a cold probe instead of stalling it. */
  getTimeoutMs?: number;
  keyPrefix?: string;
  connectionName?: string;
  /** Observability hook: a store op settled (errors are the degradation signal, not failures). */
  onResult?: (op: "get" | "set", ok: boolean) => void;
};

const DEFAULT_KEY_PREFIX = "realtime:replay-cursor:";
const DEFAULT_GET_TIMEOUT_MS = 250;
const TIMED_OUT = Symbol("replay-cursor-get-timeout");

export class RedisReplayCursorStore implements ReplayCursorStore {
  #client: RedisClient | undefined;

  constructor(private readonly options: RedisReplayCursorStoreOptions) {}

  async get(key: string): Promise<number | undefined> {
    try {
      const raw = await this.#getWithDeadline(this.#key(key));
      if (raw === TIMED_OUT) {
        this.options.onResult?.("get", false);
        logger.warn("[replayCursorStore] replay-cursor read timed out", { key });
        return undefined;
      }
      this.options.onResult?.("get", true);
      if (raw === null) {
        return undefined;
      }
      const ms = Number(raw);
      return Number.isFinite(ms) && ms > 0 ? ms : undefined;
    } catch (error) {
      this.options.onResult?.("get", false);
      logger.error("[replayCursorStore] failed to read a replay cursor", { error, key });
      return undefined;
    }
  }

  /** GET raced against the read deadline (ioredis queues commands while disconnected, which
   * would otherwise stall every poll start through an outage). */
  #getWithDeadline(key: string): Promise<string | null | typeof TIMED_OUT> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve(TIMED_OUT),
        this.options.getTimeoutMs ?? DEFAULT_GET_TIMEOUT_MS
      );
      timer.unref?.();
      this.#ensureClient()
        .get(key)
        .then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          }
        );
    });
  }

  set(key: string, ms: number): void {
    try {
      this.#ensureClient()
        .set(this.#key(key), String(ms), "PX", this.options.ttlMs)
        .then(
          () => this.options.onResult?.("set", true),
          (error) => {
            this.options.onResult?.("set", false);
            logger.error("[replayCursorStore] failed to write a replay cursor", { error, key });
          }
        );
    } catch (error) {
      this.options.onResult?.("set", false);
      logger.error("[replayCursorStore] failed to write a replay cursor", { error, key });
    }
  }

  async quit(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    if (!client) return;
    try {
      // Bounded graceful QUIT; cursor writes are best-effort, so force-close beyond it.
      await Promise.race([client.quit(), new Promise((resolve) => setTimeout(resolve, 500))]);
    } catch {
      // force-close below
    }
    client.disconnect();
  }

  #key(key: string): string {
    return `${this.options.keyPrefix ?? DEFAULT_KEY_PREFIX}${key}`;
  }

  #ensureClient(): RedisClient {
    if (!this.#client) {
      this.#client = createRedisClient(
        this.options.connectionName ?? "trigger:realtime:replay-cursors",
        this.options.redis
      );
    }
    return this.#client;
  }
}
