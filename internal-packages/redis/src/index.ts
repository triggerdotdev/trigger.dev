import { Redis, type RedisOptions } from "ioredis";
import { Logger } from "@trigger.dev/core/logger";

export { Redis, type Callback, type RedisOptions, type Result, type RedisCommander } from "ioredis";

/**
 * Reply-error -> reconnect mapping. Without this hook, an ElastiCache
 * vertical scale-up surfaces tens of thousands of READONLY / LOADING
 * reply errors to caller code over a healthy TCP/TLS connection (the
 * client keeps talking to a node whose role swapped underneath it).
 *
 * UNBLOCKED is the BLPOP-shaped case: the Redis primary forcibly
 * unblocks any blocking command on a connection whose node is about
 * to be demoted, returning an UNBLOCKED reply. Surfaced 65 times on
 * engine/v1/worker-actions/dequeue at the cutover instant during the
 * TRI-8873 test-cloud scale-up dry-run.
 *
 * Returning 2 tells ioredis to disconnect, reconnect, and retry the
 * command that triggered the error. After reconnect, DNS / SG routing
 * should land on a writable primary.
 *
 * Empirical confirmation on the harness in TRI-8878: this option
 * reduced a scale-up event from ~437,000 caller-surfaced errors to 2.
 */
export function defaultReconnectOnError(err: Error): boolean | 1 | 2 {
  const msg = err.message ?? "";
  if (
    msg.startsWith("READONLY") ||
    msg.startsWith("LOADING") ||
    msg.startsWith("UNBLOCKED")
  ) {
    return 2;
  }
  return false;
}

const defaultOptions: Partial<RedisOptions> = {
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 1000);
    return delay;
  },
  maxRetriesPerRequest: process.env.GITHUB_ACTIONS ? 50 : process.env.VITEST ? 5 : 20,
  reconnectOnError: defaultReconnectOnError,
};

const logger = new Logger("Redis", "debug");

export function createRedisClient(
  options: RedisOptions,
  handlers?: { onError?: (err: Error) => void }
): Redis {
  const client = new Redis({
    ...defaultOptions,
    ...options,
  });

  // Skip error handling setup if running in Vitest
  if (process.env.VITEST) {
    client.on("error", (error) => {
      // swallow errors
    });
    return client;
  }

  client.on("error", (error) => {
    if (handlers?.onError) {
      handlers.onError(error);
    } else {
      logger.error(`Redis client error:`, { error, keyPrefix: options.keyPrefix });
    }
  });

  return client;
}
