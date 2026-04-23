import { Redis } from "ioredis";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { logger } from "./logger.server";

// "ssw" — session-stream-waitpoint. Parallel to the input-stream variant
// (`isw:{runFriendlyId}:{streamId}`). Keyed purely on `{sessionId, io}` so
// a send() lands on the channel regardless of which run is waiting, and
// multiple concurrent waiters (e.g. two agents on one chat) all wake.
const KEY_PREFIX = "ssw:";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function buildKey(sessionFriendlyId: string, io: "out" | "in"): string {
  return `${KEY_PREFIX}${sessionFriendlyId}:${io}`;
}

function initializeRedis(): Redis | undefined {
  const host = env.CACHE_REDIS_HOST;
  if (!host) {
    return undefined;
  }

  return new Redis({
    connectionName: "sessionStreamWaitpointCache",
    host,
    port: env.CACHE_REDIS_PORT,
    username: env.CACHE_REDIS_USERNAME,
    password: env.CACHE_REDIS_PASSWORD,
    keyPrefix: "tr:",
    enableAutoPipelining: true,
    ...(env.CACHE_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  });
}

const redis = singleton("sessionStreamWaitpointCache", initializeRedis);

/**
 * Register a waitpoint as pending on the given session channel. Called
 * from the `.wait()` create-waitpoint route. Multiple waiters on the same
 * channel are allowed (stored as a Redis set).
 */
export async function addSessionStreamWaitpoint(
  sessionFriendlyId: string,
  io: "out" | "in",
  waitpointId: string,
  ttlMs?: number
): Promise<void> {
  if (!redis) return;

  try {
    const key = buildKey(sessionFriendlyId, io);
    await redis.sadd(key, waitpointId);
    await redis.pexpire(key, ttlMs ?? DEFAULT_TTL_MS);
  } catch (error) {
    logger.error("Failed to set session stream waitpoint cache", {
      sessionFriendlyId,
      io,
      error,
    });
  }
}

/**
 * Atomically read + clear all waitpoints registered on the given session
 * channel. Called from the append handler so the next append sees an
 * empty set even if two appends race.
 */
export async function drainSessionStreamWaitpoints(
  sessionFriendlyId: string,
  io: "out" | "in"
): Promise<string[]> {
  if (!redis) return [];

  try {
    const key = buildKey(sessionFriendlyId, io);
    const pipeline = redis.multi();
    pipeline.smembers(key);
    pipeline.del(key);
    const results = await pipeline.exec();
    if (!results) return [];
    const [smembersResult] = results;
    if (!smembersResult) return [];
    const [err, members] = smembersResult;
    if (err) return [];
    return Array.isArray(members) ? (members as string[]) : [];
  } catch (error) {
    logger.error("Failed to drain session stream waitpoint cache", {
      sessionFriendlyId,
      io,
      error,
    });
    return [];
  }
}

/**
 * Remove a single waitpoint from the pending set. Called after a race
 * where `.wait()` completed the waitpoint from pre-arrived data.
 */
export async function removeSessionStreamWaitpoint(
  sessionFriendlyId: string,
  io: "out" | "in",
  waitpointId: string
): Promise<void> {
  if (!redis) return;

  try {
    const key = buildKey(sessionFriendlyId, io);
    await redis.srem(key, waitpointId);
  } catch (error) {
    logger.error("Failed to remove session stream waitpoint cache entry", {
      sessionFriendlyId,
      io,
      error,
    });
  }
}
