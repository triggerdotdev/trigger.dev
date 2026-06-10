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

// Pre-env-scoping key format, drained for one release so waitpoints from the
// previous deploy still wake. Removable once this has been live > turn timeout.
function buildLegacyKey(addressingKey: string, io: "out" | "in"): string {
  return `${KEY_PREFIX}${addressingKey}:${io}`;
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
    const legacyKey = buildLegacyKey(addressingKey, io);
    const pipeline = redis.multi();
    pipeline.smembers(key);
    pipeline.del(key);
    pipeline.smembers(legacyKey);
    pipeline.del(legacyKey);
    const results = await pipeline.exec();
    if (!results) return [];
    // Union members from the env-scoped key and the legacy key (dual-read).
    const ids = new Set<string>();
    for (const idx of [0, 2]) {
      const entry = results[idx];
      if (!entry) continue;
      const [err, members] = entry;
      if (err || !Array.isArray(members)) continue;
      for (const m of members as string[]) ids.add(m);
    }
    return [...ids];
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
// "ssa" — session-stream-append. Idempotency claim for the append route:
// when a caller supplies an `X-Part-Id`, the first request atomically claims
// the key (SET NX) before appending; a concurrent or retried POST with the
// same id fails the claim and skips the append, so it never produces a
// duplicate record (or double-fires the waitpoint drain). The claim is
// released if the append fails, so a retry of a genuinely failed append
// still goes through. 5-minute window — covers retry storms, not a
// permanent idempotency store.
const APPEND_DEDUPE_PREFIX = "ssa:";
const APPEND_DEDUPE_TTL_SECONDS = 5 * 60;

function buildAppendDedupeKey(
  environmentId: string,
  addressingKey: string,
  io: "out" | "in",
  partId: string
): string {
  // Encode the free-form segments — `addressingKey` (externalId) and `partId`
  // (X-Part-Id) are user-supplied and may contain `:`, which would otherwise
  // let different tuples collide and falsely suppress an append.
  return `${APPEND_DEDUPE_PREFIX}${encodeURIComponent(environmentId)}:${encodeURIComponent(
    addressingKey
  )}:${io}:${encodeURIComponent(partId)}`;
}

/**
 * Atomically claim a part id before appending. Returns true if this caller
 * won the claim (first to see this id) and should perform the append, false
 * if the id was already claimed (a concurrent or retried POST) and the append
 * should be skipped. Fails open (returns true) when Redis is unavailable —
 * appends degrade to at-least-once, never to dropped.
 */
export async function claimSessionStreamPart(
  environmentId: string,
  addressingKey: string,
  io: "out" | "in",
  partId: string
): Promise<boolean> {
  if (!redis) return true;

  try {
    // SET NX is the atomic claim: "OK" when set (we won), null when the key
    // already exists (someone else owns this id).
    const result = await redis.set(
      buildAppendDedupeKey(environmentId, addressingKey, io, partId),
      "1",
      "EX",
      APPEND_DEDUPE_TTL_SECONDS,
      "NX"
    );
    return result === "OK";
  } catch (error) {
    logger.error("Failed to claim session stream append part", {
      environmentId,
      addressingKey,
      io,
      partId,
      error,
    });
    return true;
  }
}

/** Release a claim so a retry can proceed — called when the append itself failed. */
export async function releaseSessionStreamPart(
  environmentId: string,
  addressingKey: string,
  io: "out" | "in",
  partId: string
): Promise<void> {
  if (!redis) return;

  try {
    await redis.del(buildAppendDedupeKey(environmentId, addressingKey, io, partId));
  } catch (error) {
    logger.error("Failed to release session stream append part", {
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
