import { Redis, type RedisOptions } from "ioredis";
import { Logger } from "@trigger.dev/core/logger";

export { Redis, type Callback, type RedisOptions, type Result, type RedisCommander } from "ioredis";

const defaultOptions: Partial<RedisOptions> = {
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 1000);
    return delay;
  },
  maxRetriesPerRequest: process.env.GITHUB_ACTIONS ? 50 : process.env.VITEST ? 5 : 20,
  family: 0, // Support both IPv4 and IPv6 (Railway internal DNS)
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
