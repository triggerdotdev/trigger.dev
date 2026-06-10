import { Redis } from "ioredis";
import { defaultReconnectOnError } from "@internal/redis";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { logger } from "./logger.server";

// "ssw" — session-stream-waitpoint. Parallel to the input-stream variant
// (`isw:{runFriendlyId}:{streamId}`). Keyed on `{environmentId, addressingKey, io}`
// so a send() lands on the channel regardless of which run is waiting, and
// multiple concurrent waiters (e.g. two agents on one chat) all wake.
// The environmentId prefix is load-bearing: the addressing key is the
// user-supplied externalId (unique only per environment), and this Redis
// is shared — without it, two environments using the same externalId
// would drain each other's waitpoints.
const KEY_PREFIX = "ssw:";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function buildKey(environmentId: string, addressingKey: string, io: "out" | "in"): string {
  return `${KEY_PREFIX}${environmentId}:${addressingKey}:${io}`;
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
    reconnectOnError: defaultReconnectOnError,
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
  environmentId: string,
  addressingKey: string,
  io: "out" | "in",
  waitpointId: string,
  ttlMs?: number
): Promise<void> {
  if (!redis) return;

  try {
    const key = buildKey(environmentId, addressingKey, io);
    await redis.eval(
      ADD_WAITPOINT_SCRIPT,
      1,
      key,
      waitpointId,
      String(ttlMs ?? DEFAULT_TTL_MS)
    );
  } catch (error) {
    logger.error("Failed to set session stream waitpoint cache", {
      environmentId,
      addressingKey,
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
  environmentId: string,
  addressingKey: string,
  io: "out" | "in"
): Promise<string[]> {
  if (!redis) return [];

  try {
    const key = buildKey(environmentId, addressingKey, io);
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
      environmentId,
      addressingKey,
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
// "ssa" — session-stream-append. Best-effort idempotency marker for the
// append route: when a caller supplies an `X-Part-Id`, a retried POST
// whose first attempt actually committed is skipped instead of producing
// a duplicate record (and double-firing the waitpoint drain). The marker
// is only written AFTER a successful S2 append, so a retry of a genuinely
// failed append still goes through. 5-minute window — this covers HTTP
// retry storms, not a permanent idempotency store.
const APPEND_DEDUPE_PREFIX = "ssa:";
const APPEND_DEDUPE_TTL_SECONDS = 5 * 60;

function buildAppendDedupeKey(
  environmentId: string,
  addressingKey: string,
  io: "out" | "in",
  partId: string
): string {
  return `${APPEND_DEDUPE_PREFIX}${environmentId}:${addressingKey}:${io}:${partId}`;
}

/**
 * True if a part with this id was already successfully appended to the
 * channel within the dedupe window. Fails open (returns false) when Redis
 * is unavailable — appends degrade to at-least-once, never to dropped.
 */
export async function wasSessionStreamPartAppended(
  environmentId: string,
  addressingKey: string,
  io: "out" | "in",
  partId: string
): Promise<boolean> {
  if (!redis) return false;

  try {
    const value = await redis.get(buildAppendDedupeKey(environmentId, addressingKey, io, partId));
    return value !== null;
  } catch (error) {
    logger.error("Failed to read session stream append dedupe marker", {
      environmentId,
      addressingKey,
      io,
      partId,
      error,
    });
    return false;
  }
}

/** Record a successful append so a retried POST with the same part id is skipped. */
export async function markSessionStreamPartAppended(
  environmentId: string,
  addressingKey: string,
  io: "out" | "in",
  partId: string
): Promise<void> {
  if (!redis) return;

  try {
    await redis.set(
      buildAppendDedupeKey(environmentId, addressingKey, io, partId),
      "1",
      "EX",
      APPEND_DEDUPE_TTL_SECONDS
    );
  } catch (error) {
    logger.error("Failed to write session stream append dedupe marker", {
      environmentId,
      addressingKey,
      io,
      partId,
      error,
    });
  }
}

export async function removeSessionStreamWaitpoint(
  environmentId: string,
  addressingKey: string,
  io: "out" | "in",
  waitpointId: string
): Promise<void> {
  if (!redis) return;

  try {
    const key = buildKey(environmentId, addressingKey, io);
    await redis.srem(key, waitpointId);
  } catch (error) {
    logger.error("Failed to remove session stream waitpoint cache entry", {
      environmentId,
      addressingKey,
      io,
      error,
    });
  }
}
