import { Redis } from "ioredis";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { logger } from "./logger.server";

const KEY_PREFIX = "isw:";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function buildKey(runFriendlyId: string, streamId: string): string {
  return `${KEY_PREFIX}${runFriendlyId}:${streamId}`;
}

function initializeRedis(): Redis | undefined {
  const host = env.CACHE_REDIS_HOST;
  if (!host) {
    return undefined;
  }

  return new Redis({
    connectionName: "inputStreamWaitpointCache",
    host,
    port: env.CACHE_REDIS_PORT,
    username: env.CACHE_REDIS_USERNAME,
    password: env.CACHE_REDIS_PASSWORD,
    keyPrefix: "tr:",
    enableAutoPipelining: true,
    ...(env.CACHE_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  });
}

const redis = singleton("inputStreamWaitpointCache", initializeRedis);

/**
 * Store a mapping from input stream to waitpoint ID in Redis.
 * Called when `.wait()` creates a new waitpoint.
 */
export async function setInputStreamWaitpoint(
  runFriendlyId: string,
  streamId: string,
  waitpointId: string,
  ttlMs?: number
): Promise<void> {
  if (!redis) return;

  try {
    const key = buildKey(runFriendlyId, streamId);
    await redis.set(key, waitpointId, "PX", ttlMs ?? DEFAULT_TTL_MS);
  } catch (error) {
    logger.error("Failed to set input stream waitpoint cache", {
      runFriendlyId,
      streamId,
      error,
    });
  }
}

/**
 * Get the waitpoint ID for an input stream without deleting it.
 * Called from the `.send()` route before completing the waitpoint.
 */
export async function getInputStreamWaitpoint(
  runFriendlyId: string,
  streamId: string
): Promise<string | null> {
  if (!redis) return null;

  try {
    const key = buildKey(runFriendlyId, streamId);
    return await redis.get(key);
  } catch (error) {
    logger.error("Failed to get input stream waitpoint cache", {
      runFriendlyId,
      streamId,
      error,
    });
    return null;
  }
}

/**
 * Delete the cache entry for an input stream waitpoint.
 * Called when a waitpoint is completed or timed out.
 */
export async function deleteInputStreamWaitpoint(
  runFriendlyId: string,
  streamId: string
): Promise<void> {
  if (!redis) return;

  try {
    const key = buildKey(runFriendlyId, streamId);
    await redis.del(key);
  } catch (error) {
    logger.error("Failed to delete input stream waitpoint cache", {
      runFriendlyId,
      streamId,
      error,
    });
  }
}
