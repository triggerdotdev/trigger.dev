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

// Atomic SADD + PEXPIRE that only ever extends the key's TTL.
//
// Two concerns rolled into one script:
// 1. SADD + PEXPIRE as separate commands can leave the key with no TTL
//    if the second call fails (or the process crashes in between).
// 2. Each waitpoint registers with its own `ttlMs` (derived from the
//    waitpoint's timeout). Calling PEXPIRE unconditionally would let a
//    short-TTL registration shrink the key's TTL below a longer-TTL
//    sibling — evicting the sibling early and degrading the append-path
//    fast drain to engine-timeout-only.
//
// The script: SADD the member, then set PEXPIRE only if the new TTL is
// greater than the current PTTL (or the key has no TTL yet). Engine-
// level timeouts still fire per-waitpoint; this keeps the Redis key
// alive for the longest-lived member.
const ADD_WAITPOINT_SCRIPT = `
  redis.call("SADD", KEYS[1], ARGV[1])
  local newTtl = tonumber(ARGV[2])
  local currentTtl = redis.call("PTTL", KEYS[1])
  if currentTtl < 0 or newTtl > currentTtl then
    redis.call("PEXPIRE", KEYS[1], newTtl)
  end
  return 1
`;

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
    await redis.eval(
      ADD_WAITPOINT_SCRIPT,
      1,
      key,
      waitpointId,
      String(ttlMs ?? DEFAULT_TTL_MS)
    );
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
