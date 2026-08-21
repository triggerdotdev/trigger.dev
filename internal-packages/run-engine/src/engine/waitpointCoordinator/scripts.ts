import type { Callback, Redis, Result } from "@internal/redis";

/**
 * Lua for the waitpoint coordination protocol. Three rules hold throughout:
 *
 *  1. Every key a script touches is declared in KEYS. No script builds a key name inside
 *     Lua. ioredis prefixes only the KEYS array, so a key minted in Lua would be
 *     unprefixed while the client wrote a prefixed one — and a script with a single
 *     declared key gives the caller's single-slot assertion nothing to compare.
 *  2. Lua never parses JSON. Each script branches only on a short status string and moves
 *     opaque blobs, so every encoding decision stays in TypeScript.
 *  3. Every returned slot is coerced with `or ''`. A Lua false or nil TRUNCATES the reply
 *     array at that position, silently shortening it.
 *
 * STORED_COMPLETED is the value written into the record's `status` field and is
 * UPPERCASE. The outcome tokens below are lowercase and are a separate vocabulary: they
 * name what a script DID, not what a record IS. Sharing one constant between the two
 * makes an already-completed record invisible to every script.
 */

const STORED_COMPLETED = "COMPLETED";

const MISSING = "missing";
const CREATED = "created";
const EXISTS = "exists";
const REGISTERED = "registered";
const DID_COMPLETE = "completed";
const ALREADY = "already";
const RESERVED = "reserved";
const CLEARED = "cleared";
const DRAINED = "drained";

export function registerWaitpointCommands(redis: Redis): void {
  // KEYS: record. ARGV: recordJson, status ('PENDING'|'COMPLETED'), completionJson ('').
  redis.defineCommand("wpCreateIfAbsent", {
    numberOfKeys: 1,
    lua: `
      local record = KEYS[1]

      -- EXISTS-then-HSET inside one script, rather than a field-by-field HSETNX: the
      -- record and its status must appear together or not at all.
      if redis.call('EXISTS', record) == 1 then
        local vals = redis.call('HMGET', record, 'r', 'status', 'c')
        return { '${EXISTS}', vals[1] or '', vals[2] or '', vals[3] or '' }
      end

      redis.call('HSET', record, 'r', ARGV[1], 'status', ARGV[2])
      if ARGV[3] ~= '' then
        redis.call('HSET', record, 'c', ARGV[3])
      end

      return { '${CREATED}' }
    `,
  });

  // KEYS: record, watchers. ARGV: watcherField, watcherJson.
  redis.defineCommand("wpRegisterOrReport", {
    numberOfKeys: 2,
    lua: `
      local record, watchers = KEYS[1], KEYS[2]

      -- A missing waitpoint is never a silent no-op: the caller throws. Defaulting to
      -- "not blocked" here would resume a run whose waitpoint never completed.
      if redis.call('EXISTS', record) == 0 then
        return { '${MISSING}' }
      end

      if redis.call('HGET', record, 'status') == '${STORED_COMPLETED}' then
        return { '${DID_COMPLETE}', redis.call('HGET', record, 'c') or '' }
      end

      -- The watcher lands before any flip can read the watcher hash, because this script
      -- and wpComplete are both atomic on this same shard. So a register either appears
      -- in the flip's watcher list, or it observes COMPLETED above.
      --
      -- HSETNX: the first registration wins, mirroring the edge's ON CONFLICT DO NOTHING.
      redis.call('HSETNX', watchers, ARGV[1], ARGV[2])
      return { '${REGISTERED}' }
    `,
  });

  // KEYS: record, watchers. ARGV: completionJson.
  redis.defineCommand("wpComplete", {
    numberOfKeys: 2,
    lua: `
      local record, watchers = KEYS[1], KEYS[2]

      if redis.call('EXISTS', record) == 0 then
        return { '${MISSING}' }
      end

      local outcome = '${DID_COMPLETE}'
      if redis.call('HGET', record, 'status') == '${STORED_COMPLETED}' then
        -- Double completion is not an error, and the FIRST completion wins. This is the
        -- guard a conditional UPDATE ... WHERE status = 'PENDING' used to provide.
        outcome = '${ALREADY}'
      else
        redis.call('HSET', record, 'status', '${STORED_COMPLETED}', 'c', ARGV[1])
      end

      -- Returning the watchers here is what removes the reverse fan-out query. The
      -- envelope comes back too, because delivery runs on each watcher's own shard and
      -- cannot read this key.
      local out = { outcome, redis.call('HGET', record, 'c') or '' }
      local entries = redis.call('HVALS', watchers)
      for i = 1, #entries do
        out[#out + 1] = entries[i]
      end

      return out
    `,
  });

  // KEYS: idempotency key. ARGV: waitpointId, expiresAtMs ('' for no expiry).
  redis.defineCommand("wpIdemReserve", {
    numberOfKeys: 1,
    lua: `
      local key = KEYS[1]

      -- Guard before the SET: a non-numeric expiry must not land a reservation that can
      -- never expire because PEXPIREAT then errors out after the write already happened.
      if ARGV[2] ~= '' and tonumber(ARGV[2]) == nil then
        return redis.error_reply('wpIdemReserve: ARGV[2] must be numeric or empty')
      end

      -- SET NX returns a status reply on success and false on conflict.
      if redis.call('SET', key, ARGV[1], 'NX') then
        -- Expiry only when the caller has one. A reservation with no expiry is the common
        -- case and must never grow one here.
        if ARGV[2] ~= '' then
          redis.call('PEXPIREAT', key, tonumber(ARGV[2]))
        end
        return { '${RESERVED}', ARGV[1] }
      end

      return { '${EXISTS}', redis.call('GET', key) or '' }
    `,
  });

  // KEYS: pend, done, edge.
  // ARGV: n, then n groups of 4 — waitpointId, edgeField, edgeJson, reportedJson ('').
  redis.defineCommand("runAbsorbBlockers", {
    numberOfKeys: 3,
    lua: `
      local pend, done, edge = KEYS[1], KEYS[2], KEYS[3]
      local n = tonumber(ARGV[1])

      -- Guard before any write: a wrong n must not half-apply the script. HDEL/HSETNX below
      -- are irreversible mid-script, and Redis does not roll back a script that errors.
      if #ARGV ~= 1 + n * 4 then
        return redis.error_reply('runAbsorbBlockers: arity mismatch')
      end

      -- seenDelivered makes the delivered-pair output DISTINCT BY ID: two edges for one
      -- waitpoint must contribute one pair, not two.
      local requestedIds = {}
      local seenDelivered = {}
      local out = { '0', '0' }

      for i = 0, n - 1 do
        local id       = ARGV[2 + i * 4]
        local field    = ARGV[3 + i * 4]
        local edgeJson = ARGV[4 + i * 4]
        local reported = ARGV[5 + i * 4]

        -- HSETNX is the ON CONFLICT DO NOTHING of the edge write: a retry must not
        -- overwrite the first attempt's metadata.
        redis.call('HSETNX', edge, field, edgeJson)
        requestedIds[id] = true

        if reported ~= '' then
          -- Already COMPLETED when the watcher registered. It never becomes pending.
          redis.call('HSET', done, id, reported)
          redis.call('SREM', pend, id)
          if not seenDelivered[id] then
            seenDelivered[id] = true
            out[#out + 1] = id
            out[#out + 1] = reported
          end
        else
          -- Check the delivered set FIRST. A completion that landed between register and
          -- absorb has already delivered here, and that delivery wins.
          local delivered = redis.call('HGET', done, id)
          if delivered then
            if not seenDelivered[id] then
              seenDelivered[id] = true
              out[#out + 1] = id
              out[#out + 1] = delivered
            end
          else
            redis.call('SADD', pend, id)
          end
        end
      end

      -- Computed AFTER every write in this batch, as the count of distinct requested ids
      -- with no entry in done. Counting incrementally during the loop is order-dependent:
      -- a later group's completion for an id already counted as pending would leave the
      -- count stale, reporting a waitpoint as both pending and delivered.
      local pendingOfRequested = 0
      for id in pairs(requestedIds) do
        if redis.call('HEXISTS', done, id) == 0 then
          pendingOfRequested = pendingOfRequested + 1
        end
      end

      out[1] = tostring(pendingOfRequested)
      out[2] = tostring(redis.call('SCARD', pend))
      return out
    `,
  });

  // KEYS: pend, done. ARGV: waitpointId, completionJson.
  redis.defineCommand("runDeliverCompletion", {
    numberOfKeys: 2,
    lua: `
      local pend, done = KEYS[1], KEYS[2]

      redis.call('HSET', done, ARGV[1], ARGV[2])
      redis.call('SREM', pend, ARGV[1])

      -- The caller treats this as a wakeup trigger, not as the resume decision: the
      -- resume is decided under the run lock, and this count covers store-resident
      -- blockers only.
      return { tostring(redis.call('SCARD', pend)) }
    `,
  });

  // KEYS: pend, done, edge.
  redis.defineCommand("runReadBlockState", {
    numberOfKeys: 3,
    lua: `
      local pend, done, edge = KEYS[1], KEYS[2], KEYS[3]

      local pendIds = redis.call('SMEMBERS', pend)
      -- HKEYS, never HGETALL: the delivered set's values are completion envelopes with
      -- inline outputs, and materializing those inside a single-threaded script would
      -- block the shard.
      local doneIds = redis.call('HKEYS', done)
      local edges   = redis.call('HGETALL', edge)

      local out = { tostring(#pendIds), tostring(#doneIds), tostring(#edges) }
      for i = 1, #pendIds do out[#out + 1] = pendIds[i] end
      for i = 1, #doneIds do out[#out + 1] = doneIds[i] end
      for i = 1, #edges   do out[#out + 1] = edges[i]   end
      return out
    `,
  });

  // KEYS: pend, done, edge. ARGV: n, then n edge fields. n = 0 clears everything.
  redis.defineCommand("runClear", {
    numberOfKeys: 3,
    lua: `
      local pend, done, edge = KEYS[1], KEYS[2], KEYS[3]
      local n = tonumber(ARGV[1])

      -- Guard before any write, same reasoning as runAbsorbBlockers.
      if #ARGV ~= 1 + n then
        return redis.error_reply('runClear: arity mismatch')
      end

      if n == 0 then
        redis.call('DEL', pend, done, edge)
        return { '${CLEARED}' }
      end

      for i = 1, n do
        redis.call('HDEL', edge, ARGV[1 + i])
      end

      -- Reconcile rather than delete by name. The edge set is the authority: after the
      -- drain, pend and done may only hold ids that some surviving edge still references.
      --
      -- Two reasons this is a superset of "remove the drained ids". First, one waitpoint
      -- can hold several edges at different batch indexes, so a drained field must not
      -- evict a delivery another edge still needs. Second, runDeliverCompletion writes
      -- done[id] unconditionally, so a crash between register and absorb can leave a
      -- delivered entry with no edge at all, which no name-derived drain could reach.
      local remaining = {}
      local fields = redis.call('HKEYS', edge)
      for i = 1, #fields do
        local sep = string.find(fields[i], '#[^#]*$')
        if sep then
          remaining[string.sub(fields[i], 1, sep - 1)] = true
        end
      end

      local doneIds = redis.call('HKEYS', done)
      for i = 1, #doneIds do
        if not remaining[doneIds[i]] then
          redis.call('HDEL', done, doneIds[i])
        end
      end

      local pendIds = redis.call('SMEMBERS', pend)
      for i = 1, #pendIds do
        if not remaining[pendIds[i]] then
          redis.call('SREM', pend, pendIds[i])
        end
      end

      return { '${DRAINED}' }
    `,
  });
}

declare module "@internal/redis" {
  interface RedisCommander<Context> {
    wpCreateIfAbsent(
      recordKey: string,
      recordJson: string,
      status: string,
      completionJson: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    wpRegisterOrReport(
      recordKey: string,
      watchersKey: string,
      watcherField: string,
      watcherJson: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    wpComplete(
      recordKey: string,
      watchersKey: string,
      completionJson: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    wpIdemReserve(
      key: string,
      waitpointId: string,
      expiresAtMs: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    runAbsorbBlockers(
      pendKey: string,
      doneKey: string,
      edgeKey: string,
      ...args: Array<string | Callback<string[]>>
    ): Result<string[], Context>;
    runDeliverCompletion(
      pendKey: string,
      doneKey: string,
      waitpointId: string,
      completionJson: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    runReadBlockState(
      pendKey: string,
      doneKey: string,
      edgeKey: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    runClear(
      pendKey: string,
      doneKey: string,
      edgeKey: string,
      ...args: Array<string | Callback<string[]>>
    ): Result<string[], Context>;
  }
}
