import { Redis } from "ioredis";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { logger } from "./logger.server";

const KEY_PREFIX = "cli-notif-ctr:";
const MAX_COUNTER = 1000;

function initializeRedis(): Redis | undefined {
  const host = env.CACHE_REDIS_HOST;
  if (!host) return undefined;

  return new Redis({
    connectionName: "platformNotificationCounter",
    host,
    port: env.CACHE_REDIS_PORT,
    username: env.CACHE_REDIS_USERNAME,
    password: env.CACHE_REDIS_PASSWORD,
    keyPrefix: "tr:",
    enableAutoPipelining: true,
    ...(env.CACHE_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  });
}

const redis = singleton("platformNotificationCounter", initializeRedis);

/** Increment and return the user's CLI request counter (0-based, wraps at 1000→0). */
export async function incrementCliRequestCounter(userId: string): Promise<number> {
  if (!redis) return 0;

  try {
    const key = `${KEY_PREFIX}${userId}`;
    const value = await redis.incr(key);

    if (value > MAX_COUNTER) {
      await redis.set(key, "0");
      return 0;
    }

    return value;
  } catch (error) {
    logger.error("Failed to increment CLI notification counter", { userId, error });
    return 0;
  }
}
