/**
 * Lua scripts for the webhook waiter store. Every key a script touches carries the same
 * `{endpointId}` hash tag, so each script runs on one cluster slot. Scripts read the server clock
 * (`TIME`) so webapp instances with clock skew prune and compare consistently, and every script is
 * idempotent because the client re-sends in-flight commands after a failover.
 *
 * `PEXPIREAT ... GT` never sets a TTL on a key that has none, so every TTL extension goes through
 * `extend`, which sets it outright when the key has no TTL yet.
 */
const HELPERS = `
local function nowms()
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end

local function extend(key, atMs)
  local pttl = redis.call('PTTL', key)
  if pttl == -1 then
    redis.call('PEXPIREAT', key, atMs)
  elseif pttl >= 0 then
    redis.call('PEXPIREAT', key, atMs, 'GT')
  end
end

local function pruneScored(zkey, hkey, now)
  local old = redis.call('ZRANGEBYSCORE', zkey, '-inf', '(' .. now)
  if #old > 0 then
    redis.call('ZREMRANGEBYSCORE', zkey, '-inf', '(' .. now)
    if hkey then
      for _, m in ipairs(old) do redis.call('HDEL', hkey, m) end
    end
  end
end

local function setState(wwst, wwsx, wp, state, untilMs)
  redis.call('HSET', wwst, wp, state)
  redis.call('ZADD', wwsx, untilMs, wp)
  extend(wwst, untilMs)
  extend(wwsx, untilMs)
end
`;

/**
 * The ingest front gate. Claims the dedupe key with a short lock, and on a fresh claim returns the
 * shard's clock (the delivery's arrival time, compared against waiters' registration times on the
 * same clock) plus the live match shapes and live waiters on the endpoint. A shape's score is the
 * latest expiry among its waiters and outlives a cancel or claim, so liveness also needs a waiter
 * still in the endpoint's live set.
 *
 * KEYS: gate, ws, wwe. ARGV: value, claimTtlSeconds.
 * Returns {1, arrivedAtMs, liveShapes, liveWaiters} on a claim, {0, existingValue} on a duplicate.
 */
export const FRONT_GATE = `${HELPERS}
local gate, ws, wwe = KEYS[1], KEYS[2], KEYS[3]
if redis.call('SET', gate, ARGV[1], 'EX', tonumber(ARGV[2]), 'NX') then
  local now = nowms()
  return {1, now, redis.call('ZCOUNT', ws, now, '+inf'), redis.call('ZCOUNT', wwe, now, '+inf')}
end
return {0, redis.call('GET', gate) or ''}
`;

/**
 * Hold a slot for a waiter before its waitpoint exists, so a limit breach is reported before any
 * waitpoint or timeout job is created.
 *
 * KEYS: ww, wwf, wwe, ws, wsp. ARGV: token, reserveTtlMs, shape, maxPerEndpoint, maxShapes, trackShape.
 */
export const RESERVE = `${HELPERS}
local ww, wwf, wwe, ws, wsp = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local now = nowms()
local token, ttl, shape = ARGV[1], tonumber(ARGV[2]), ARGV[3]
local maxEp, maxShapes = tonumber(ARGV[4]), tonumber(ARGV[5])
local trackShape = ARGV[6] == '1'
pruneScored(ww, wwf, now)
pruneScored(wwe, nil, now)
pruneScored(ws, wsp, now)
local epCount = redis.call('ZCARD', wwe)
if epCount >= maxEp then return {'endpoint_limit'} end
if trackShape and not redis.call('ZSCORE', ws, shape) and redis.call('ZCARD', ws) >= maxShapes then
  return {'shape_limit'}
end
local exp = now + ttl
redis.call('ZADD', ww, exp, 'r:' .. token)
redis.call('ZADD', wwe, exp, 'r:' .. token)
extend(ww, exp)
extend(wwe, exp)
return {'ok'}
`;

/**
 * Hold an environment-wide slot for a waiter, pruning expired ones first. The environment's live set
 * sits on its own slot (`{environmentId}`), so it is checked before the endpoint's reserve rather
 * than in the same script. A slot it holds but no longer needs (a failed create) drops out when its
 * score passes, so an error can only refuse a create early, never exceed the cap.
 *
 * KEYS: wwenv. ARGV: member, ttlMs, maxPerEnvironment. Returns {'ok'} or {'environment_limit'}.
 */
export const ENV_RESERVE = `${HELPERS}
local wwenv = KEYS[1]
local now = nowms()
local member, cap = ARGV[1], tonumber(ARGV[3])
local untilMs = now + tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', wwenv, '-inf', '(' .. now)
if not redis.call('ZSCORE', wwenv, member) and redis.call('ZCARD', wwenv) >= cap then
  return {'environment_limit'}
end
redis.call('ZADD', wwenv, untilMs, member)
extend(wwenv, untilMs)
return {'ok'}
`;

/**
 * Swap a waiter's environment reservation for the registered waiter, live until it expires.
 *
 * KEYS: wwenv. ARGV: reservation, waiterId, expiresAtMs.
 */
export const ENV_CONFIRM = `${HELPERS}
local wwenv = KEYS[1]
redis.call('ZREM', wwenv, ARGV[1])
redis.call('ZADD', wwenv, tonumber(ARGV[3]), ARGV[2])
extend(wwenv, tonumber(ARGV[3]))
return 1
`;

/**
 * Register a minted waiter. The per-waiter state record is the idempotency check: a claimed waiter
 * has already left the live set, so a retried register must not re-insert it. Registration time is
 * the server clock, so the created-before-arrival rule compares on one clock.
 *
 * KEYS: ww, wwf, wwe, ws, wsp, wwst, wwsx.
 * ARGV: token, waiterId, expiresAtMs, filter, shape, pathsJson, maxPerEndpoint, maxShapes, trackShape.
 */
export const REGISTER = `${HELPERS}
local ww, wwf, wwe, ws, wsp, wwst, wwsx = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7]
local now = nowms()
local token, wp, expiresAt, info = ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4]
local shape, paths = ARGV[5], ARGV[6]
local maxEp, maxShapes = tonumber(ARGV[7]), tonumber(ARGV[8])
local trackShape = ARGV[9] == '1'

pruneScored(wwsx, wwst, now)
local st = redis.call('HGET', wwst, wp)
if st then
  redis.call('ZREM', ww, 'r:' .. token)
  redis.call('ZREM', wwe, 'r:' .. token)
  if st == 'r' then return {'registered', now} end
  if st == 'x' then return {'cancelled', now} end
  return {'claimed', now, string.sub(st, 3)}
end

pruneScored(ww, wwf, now)
pruneScored(ws, wsp, now)
local hadReservation = redis.call('ZREM', ww, 'r:' .. token)
redis.call('ZREM', wwe, 'r:' .. token)
if hadReservation == 0 then
  pruneScored(wwe, nil, now)
  if redis.call('ZCARD', wwe) >= maxEp then return {'endpoint_limit', now} end
end
if trackShape and not redis.call('ZSCORE', ws, shape) and redis.call('ZCARD', ws) >= maxShapes then
  return {'shape_limit', now}
end

redis.call('ZADD', ww, expiresAt, wp)
redis.call('ZADD', wwe, expiresAt, wp)
redis.call('HSET', wwf, wp, now .. '|' .. info)
setState(wwst, wwsx, wp, 'r', expiresAt)
extend(ww, expiresAt)
extend(wwf, expiresAt)
extend(wwe, expiresAt)
if trackShape then
  redis.call('ZADD', ws, 'GT', expiresAt, shape)
  redis.call('HSET', wsp, shape, paths)
  extend(ws, expiresAt)
  extend(wsp, expiresAt)
end
return {'registered', now}
`;

/**
 * Cancel a registered waiter. A waiter a delivery already claimed answers `too_late` with that
 * delivery's id, and the run resumes with the event.
 *
 * KEYS: ww, wwf, wwe, wwst, wwsx. ARGV: waiterId.
 */
export const CANCEL = `${HELPERS}
local ww, wwf, wwe, wwst, wwsx = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local now = nowms()
local wp = ARGV[1]
local st = redis.call('HGET', wwst, wp)
if st == 'x' then return {'cancelled'} end
if st and string.sub(st, 1, 2) == 'c:' then return {'too_late', string.sub(st, 3)} end
if redis.call('ZREM', ww, wp) == 0 then return {'not_found'} end
redis.call('HDEL', wwf, wp)
redis.call('ZREM', wwe, wp)
setState(wwst, wwsx, wp, 'x', now + 3600000)
return {'cancelled'}
`;

/**
 * Claim every candidate waiter for one delivery, across any number of match keys. Only ids still in
 * their key count, so concurrent deliveries can't both claim a waiter. The claim record is marked
 * `__decided__` once and never deleted when empty (it expires), so a retried delivery returns the
 * ids it already claimed instead of matching again. The counts hash holds how many were claimed and
 * how many failed to resume, which is what the delivery's waiter summary reports.
 *
 * KEYS: wwc, wwcm, wwst, wwsx, then (ww, wwf) per group. ARGV: deliveryId, then (count, ...ids) per group.
 * Returns {'decided' | 'done', claimed, failed, ...claimedIdsNotYetAcked}.
 */
export const CLAIM = `${HELPERS}
local wwc, wwcm, wwst, wwsx = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local now = nowms()
local d = ARGV[1]

local function reply(status)
  local out = {status, tonumber(redis.call('HGET', wwcm, 'claimed') or '0'), tonumber(redis.call('HGET', wwcm, 'failed') or '0')}
  for _, m in ipairs(redis.call('SMEMBERS', wwc)) do
    if m ~= '__decided__' then table.insert(out, m) end
  end
  return out
end

if redis.call('SISMEMBER', wwc, '__decided__') == 1 then
  return reply('decided')
end

local claimedUntil = now + 3600000
local claimed = 0
local a = 2
local k = 5
while a <= #ARGV do
  local n = tonumber(ARGV[a])
  local ww, wwf = KEYS[k], KEYS[k + 1]
  for i = 1, n do
    local id = ARGV[a + i]
    if redis.call('ZREM', ww, id) == 1 then
      redis.call('HDEL', wwf, id)
      redis.call('SADD', wwc, id)
      redis.call('HSET', wwst, id, 'c:' .. d)
      redis.call('ZADD', wwsx, claimedUntil, id)
      claimed = claimed + 1
    end
  end
  a = a + n + 1
  k = k + 2
end
if claimed > 0 then
  extend(wwst, claimedUntil)
  extend(wwsx, claimedUntil)
end
redis.call('SADD', wwc, '__decided__')
redis.call('HSET', wwcm, 'claimed', claimed, 'failed', 0)
redis.call('PEXPIRE', wwc, 86400000)
redis.call('PEXPIRE', wwcm, 86400000)
return reply('done')
`;

/**
 * Take resumed (`ok`) or given-up (`failed`) waiters out of the delivery's claim record and the
 * endpoint's live set, and report the claim's counts after it.
 *
 * The first give-up error is kept for the delivery's summary.
 *
 * KEYS: wwc, wwcm, wwe. ARGV: mode, error, ...waiterIds. Returns {remaining, claimed, failed, error}.
 */
export const ACK = `
local wwc, wwcm, wwe = KEYS[1], KEYS[2], KEYS[3]
local removed = 0
for i = 3, #ARGV do
  local id = ARGV[i]
  if redis.call('SREM', wwc, id) == 1 then
    redis.call('ZREM', wwe, id)
    removed = removed + 1
  end
end
if ARGV[1] == 'failed' and removed > 0 then
  redis.call('HINCRBY', wwcm, 'failed', removed)
  if ARGV[2] ~= '' then redis.call('HSETNX', wwcm, 'error', ARGV[2]) end
end
local remaining = redis.call('SCARD', wwc)
if redis.call('SISMEMBER', wwc, '__decided__') == 1 then remaining = remaining - 1 end
return {remaining, tonumber(redis.call('HGET', wwcm, 'claimed') or '0'), tonumber(redis.call('HGET', wwcm, 'failed') or '0'), redis.call('HGET', wwcm, 'error') or ''}
`;
