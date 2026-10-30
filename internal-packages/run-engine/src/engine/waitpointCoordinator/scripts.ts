import type { Callback, RedisClient, Result } from "@internal/redis";

/**
 * Lua for the waitpoint coordination protocol. Scripts assume protocol-owned key types and command
 * permissions. Atomic execution excludes interleaving; Redis does not roll back a command error.
 * Recovery handles interruption and lost replies between script invocations and cross-shard work.
 *
 * Four rules hold throughout:
 *
 *  1. Every key a script touches is declared in KEYS. No script builds a key name inside
 *     Lua. ioredis prefixes only the KEYS array, so a key minted in Lua would be
 *     unprefixed while the client wrote a prefixed one — and a script with a single
 *     declared key gives the caller's single-slot assertion nothing to compare.
 *  2. Completion/edge payloads remain opaque. Watcher registration decodes watcher JSON
 *     only to fill missing cached-span metadata on a duplicate registration.
 *  3. A missing HGET returns Lua `false`, not `nil` — measured directly against a live
 *     Redis: `EVAL "return {'a', false, 'c'}"` and a table holding a missing-field HGET
 *     result both come back as 3 elements; only `EVAL "return {'a', nil, 'c'}"` comes back
 *     as 1. A `false` element converts to a reply-array null and does NOT shorten anything
 *     after it — only a genuine Lua nil truncates. Every returned slot is still coerced
 *     with `or ''` regardless, not to prevent truncation, but so an absent value arrives
 *     as `''` rather than `null`, giving the TypeScript one shape to decode instead of
 *     two.
 *  4. No script returns a collection whose size is set by how many watchers a waitpoint
 *     has. Every watcher-facing read takes an explicit page bound in ARGV and uses a range
 *     with a computed stop index, so the reply size is a property of the call and not of
 *     the data. `LLEN` and `HDEL` are how the foreground touches the watcher set.
 *
 * STORED_COMPLETED is the value written into the record's `status` field and is
 * UPPERCASE. The outcome tokens below are lowercase and are a separate vocabulary: they
 * name what a script DID, not what a record IS. Sharing one constant between the two
 * makes an already-completed record invisible to every script.
 *
 * ## Record fields (`wp:v1:{id}`)
 *
 * `r` record blob · `status` PENDING|COMPLETED · `c` completion envelope ·
 * `cid` completion identity (see wpComplete) · `cAt` completion time in ms.
 *
 * ## Fanout entry fields (`wp:v1:{id}:f`)
 *
 * `state` pending|done|quarantined · `nb` the AUTHORITATIVE earliest claim time in ms, which
 * is what enforces a retry backoff · `owner` claiming worker id or '' · `lease` ms epoch
 * at which the claim lapses · `att` claim attempts, a diagnostic · `fail` the CONSECUTIVE
 * failure streak the give-up threshold is measured against, which any progress resets ·
 * `cAt` completion time in ms · `del` watchers acknowledged so far · `doneAt`/`qAt`
 * transition times.
 *
 * `ep` is the claim fence: monotonic, minted by wpFanoutClaim and quoted by every later
 * transition for that claim. `ackEp` and `failEp` record which epoch's trim and which
 * epoch's failure have already landed, so a command ioredis resends after its reply was
 * lost reports the first application's outcome rather than applying a second one.
 *
 * ## Run block-state fields (`wp:v1:run:{runId}:st`)
 *
 * `blk` current block operation id · `hs` handoff state ''|owed|ack · `term` '1' once the
 * run has been through terminal cleanup. See runDeliverCompletion for why `blk` gates
 * delivery.
 */

/** Hard ceiling for a single cleanup script's work and target reply. */
export const RUN_CLEANUP_PAGE_SIZE = 128;

const STORED_COMPLETED = "COMPLETED";

const MISSING = "missing";
const CREATED = "created";
const EXISTS = "exists";
const REGISTERED = "registered";
const DID_COMPLETE = "completed";
const ALREADY = "already";
const CONFLICT = "conflict";
const RESERVED = "reserved";
const CLEARED = "cleared";
const DRAINED = "drained";
const DISCARDED = "discarded";
const ABSENT = "absent";
const DONE = "done";
const QUARANTINED = "quarantined";
const BUSY = "busy";
const CLAIMED = "claimed";
const LOST = "lost";
const RELEASED = "released";
const MORE = "more";
const UNREGISTERED = "unregistered";
const STALE = "stale";
const TERMINAL = "terminal";
const DELIVERED = "delivered";
const DUPLICATE = "duplicate";
const ACKNOWLEDGED = "acknowledged";
const UNKNOWN = "unknown";
const RETAINED = "retained";
const ARMED = "armed";
const CLEANUP_OWED = "cleanupOwed";
const PENDING_RECORD = "pending-record";
const ACKED = "acked";
const NOT_DUE = "notdue";
const ABSORBED = "absorbed";

/**
 * Prepended to every script that writes active run coordination state.
 *
 * A run partition that has been through terminal cleanup carries a TTL on all four keys.
 * A later write of ACTIVE coordination state onto those keys without clearing the expiry
 * would silently vanish mid-block — the one failure the retention rule exists to prevent.
 * PERSIST is a no-op on a key with no TTL and on a key that does not exist, so this costs
 * four cheap calls and removes the whole class.
 */
const PERSIST_RUN_KEYS = `
      for i = 1, 4 do redis.call('PERSIST', KEYS[i]) end
`;

// An accepted registration retains its source until a watcher or parent result owns completion.
export const RETAIN_WAITPOINT_RECORD = `
      if (tonumber(redis.call('HGET', record, 'rh')) or 0) == 0 then
        redis.call('PEXPIRE', record, ttl)
      end
`;

export function registerWaitpointCommands(redis: RedisClient): void {
  /**
   * KEYS: record. ARGV: recordJson, status ('PENDING'|'COMPLETED'), completionJson (''),
   * terminalTtlMs.
   *
   * A record created PENDING gets no TTL — it is active state. A record created already
   * COMPLETED is terminal the moment it exists: no watcher can register against a COMPLETED
   * record, so it owes no fanout and there is nothing for it to wait for. It therefore takes
   * its retention window here, or it would sit in the keyspace forever.
   *
   * An EXISTING record is returned untouched, so a repeated create never extends a window
   * that has already been armed.
   */
  redis.defineCommand("wpCreateIfAbsent", {
    numberOfKeys: 1,
    lua: `
      local record = KEYS[1]

      local ttl = tonumber(ARGV[4])
      if ttl == nil or ttl <= 0 then
        return redis.error_reply('wpCreateIfAbsent: ARGV[4] must be a positive TTL in ms')
      end

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
      -- The immutable completed-run identity, stored as its own field so fanout and registration can read
      -- it once per page (as cachedRunId) without decoding the whole record.
      if ARGV[5] ~= nil and ARGV[5] ~= '' then
        redis.call('HSET', record, 'cbt', ARGV[5])
      end
      if ARGV[2] == '${STORED_COMPLETED}' then
        redis.call('PEXPIRE', record, ttl)
      end

      return { '${CREATED}' }
    `,
  });

  // KEYS: record, watchers, queue. ARGV: watcherField, watcherJson.
  redis.defineCommand("wpRegisterOrReport", {
    numberOfKeys: 3,
    lua: `
      local record, watchers, queue = KEYS[1], KEYS[2], KEYS[3]

      -- A missing waitpoint is never a silent no-op: the caller throws. Defaulting to
      -- "not blocked" here would resume a run whose waitpoint never completed.
      if redis.call('EXISTS', record) == 0 then
        return { '${MISSING}' }
      end

      if redis.call('HGET', record, 'status') == '${STORED_COMPLETED}' then
        -- Return the completed-run identity (cbt) in the SAME atomic reply as the completion envelope, so a
        -- delivered completion and its cachedRunId can never diverge at the record's expiry.
        return {
          '${DID_COMPLETE}',
          redis.call('HGET', record, 'c') or '',
          redis.call('HGET', record, 'cbt') or '',
          redis.call('HGET', record, 'r') or ''
        }
      end

      -- The watcher lands before any flip can read the watcher set, because this script
      -- and wpComplete are both atomic on this same shard. So a register either appears
      -- in the flip's watcher set, or it observes COMPLETED above.
      --
      -- HSETNX: keep one watcher per run/block/index. Source-publication recovery can
      -- register before the foreground creates its cached span, so a duplicate may fill
      -- an absent span (and its creation time). The first actual span still wins.
      -- The queue is pushed only when HSETNX actually set the field, keeping the two in
      -- step: the hash is the authority for whether a watcher is still live (a cancellation
      -- HDELs it), the queue is the paging order the fanout worker walks.
      if redis.call('HSETNX', watchers, ARGV[1], ARGV[2]) == 1 then
        redis.call('RPUSH', queue, ARGV[1])
      else
        local incoming = cjson.decode(ARGV[2])
        if incoming.spanIdToComplete and incoming.spanIdToComplete ~= cjson.null and incoming.spanIdToComplete ~= '' then
          local existing = cjson.decode(redis.call('HGET', watchers, ARGV[1]))
          if not existing.spanIdToComplete or existing.spanIdToComplete == cjson.null or existing.spanIdToComplete == '' then
            existing.spanIdToComplete = incoming.spanIdToComplete
            existing.createdAt = incoming.createdAt
            redis.call('HSET', watchers, ARGV[1], cjson.encode(existing))
          end
        end
      end
      return { '${REGISTERED}' }
    `,
  });

  /**
   * KEYS: record, watchers, queue, fanout.
   * ARGV: completionJson, completionId, nowMs, terminalTtlMs.
   *
   * The atomic half of completion: freeze the envelope and record the fanout obligation,
   * in bounded time regardless of how many watchers are registered. The watcher set is
   * touched only by LLEN.
   *
   * `completionId` is the caller's identity for this completion — a fingerprint over the
   * semantic fields, deliberately excluding the timestamp, so a retry of the SAME logical
   * completion matches and a genuinely different second completion does not. An empty
   * stored or incoming id means "cannot compare", which resolves to idempotent success: a
   * false conflict quarantines a healthy waitpoint, which is worse than missing a real one.
   */
  redis.defineCommand("wpComplete", {
    numberOfKeys: 4,
    lua: `
      local record, watchers, queue, fanout = KEYS[1], KEYS[2], KEYS[3], KEYS[4]

      -- Guard before any write: a bad TTL must not leave a COMPLETED record whose
      -- terminal arming errored out after the flip already happened.
      local ttl = tonumber(ARGV[4])
      if ttl == nil or ttl <= 0 then
        return redis.error_reply('wpComplete: ARGV[4] must be a positive TTL in ms')
      end

      if redis.call('EXISTS', record) == 0 then
        return { '${MISSING}' }
      end

      if redis.call('HGET', record, 'status') == '${STORED_COMPLETED}' then
        local storedId = redis.call('HGET', record, 'cid') or ''
        if storedId ~= '' and ARGV[2] ~= '' and storedId ~= ARGV[2] then
          return { '${CONFLICT}', redis.call('HGET', record, 'c') or '', storedId }
        end

        -- Double completion is not an error, and the FIRST completion wins. This is the
        -- guard a conditional UPDATE ... WHERE status = 'PENDING' used to provide. The
        -- fanout entry is NOT recreated: a drained fanout must not restart on every
        -- duplicate completion.
        return {
          '${ALREADY}',
          redis.call('HGET', record, 'c') or '',
          redis.call('HGET', fanout, 'state') or '${ABSENT}'
        }
      end

      redis.call('HSET', record,
        'status', '${STORED_COMPLETED}', 'c', ARGV[1], 'cid', ARGV[2], 'cAt', ARGV[3])

      -- LLEN and HLEN are both O(1). This is the whole reason foreground completion is
      -- bounded: the decision needs to know only WHETHER there is a live watcher, never
      -- which ones. Both counts are consulted because they answer different questions —
      -- the queue is what a page is read from, the hash is what is still registered — and
      -- a run that went terminal while blocked leaves the first non-empty and the second
      -- empty, with nothing to deliver.
      if redis.call('LLEN', queue) > 0 and redis.call('HLEN', watchers) > 0 then
        redis.call('HSET', fanout,
          'state', 'pending', 'owner', '', 'lease', '0', 'att', '0', 'cAt', ARGV[3], 'del', '0',
          -- Due immediately. The nb field is the AUTHORITATIVE earliest claim time from
          -- here on, so it has to exist from the moment the entry does.
          'nb', ARGV[3])
        -- Deliberately no TTL on the record while fanout is owed: incomplete fanout is
        -- active state.
        return { '${DID_COMPLETE}', ARGV[1], 'pending' }
      end

      -- No watcher can register after the flip — wpRegisterOrReport returns the envelope
      -- instead — so reaching here means the live watcher set is final and empty. No fanout
      -- is owed, every lifecycle obligation is already discharged, and the record is
      -- terminal from this instant.
      --
      -- The queue is dropped rather than expired. It can still hold the field names of
      -- watchers that were withdrawn while the waitpoint was pending, and those would
      -- otherwise sit on a key with no reader and no TTL.
      redis.call('DEL', queue, watchers)
${RETAIN_WAITPOINT_RECORD}
      return { '${DID_COMPLETE}', ARGV[1], '${ABSENT}' }
    `,
  });

  /**
   * KEYS: record, watchers, queue, fanout.
   * ARGV: workerId, nowMs, leaseMs, pageSize.
   *
   * Take or renew the claim on one waitpoint's fanout entry and return ONE bounded page of
   * watchers, without advancing the queue. Nothing is consumed here: the page stays
   * re-readable until wpFanoutAck trims it, which is what makes a worker that dies mid-page
   * cost a duplicate delivery rather than a lost wake-up. A claim whose lease has lapsed is
   * taken over by whoever asks next; that is the whole reclaiming mechanism.
   */
  redis.defineCommand("wpFanoutClaim", {
    numberOfKeys: 4,
    lua: `
      local record, watchers, queue, fanout = KEYS[1], KEYS[2], KEYS[3], KEYS[4]

      local now = tonumber(ARGV[2])
      local leaseMs = tonumber(ARGV[3])
      local pageSize = tonumber(ARGV[4])
      if now == nil or leaseMs == nil or pageSize == nil or pageSize < 1 then
        return redis.error_reply('wpFanoutClaim: nowMs, leaseMs and a pageSize >= 1 are required')
      end

      -- No fanout entry. Whether the hint that led here is safe to retire depends on the
      -- RECORD, because the hint and the completion flip are separate cross-slot operations
      -- and a sweep can land between them.
      if redis.call('EXISTS', fanout) == 0 then
        if redis.call('EXISTS', record) == 0 then
          return { '${ABSENT}', 'no-record' }
        end
        if redis.call('HGET', record, 'status') == '${STORED_COMPLETED}' then
          -- Completed and owing nothing: either it never had a watcher, or its fanout
          -- drained and the entry has since expired. Retiring the hint is correct.
          return { '${ABSENT}', 'completed' }
        end
        -- Still PENDING. A completion may have filed its hint and not yet flipped, so the
        -- fanout entry this hint exists for may be about to appear. Retiring the hint here
        -- is exactly the lost wake-up the hint-before-flip order exists to prevent.
        return { '${PENDING_RECORD}' }
      end

      local state = redis.call('HGET', fanout, 'state')
      if state == 'done' then
        return { '${DONE}' }
      end
      if state == 'quarantined' then
        -- The failure streak, not the attempt count: the caller reports this slot as
        -- failures, and att increments on every claim including the successful ones.
        return { '${QUARANTINED}', redis.call('HGET', fanout, 'fail') or '0' }
      end

      -- The backoff lives HERE, not in the partition index. The index is on another slot,
      -- so a worker that failed cannot atomically install its retry delay there: between
      -- the release and the index write the old score is still due, and a sweep landing in
      -- that window used to re-claim at once, fail again, and burn the whole failure budget
      -- with no backoff at all. Refusing the claim closes that off wherever the index is.
      local notBefore = tonumber(redis.call('HGET', fanout, 'nb') or '0') or 0
      if now < notBefore then
        return { '${NOT_DUE}', tostring(notBefore) }
      end

      local owner = redis.call('HGET', fanout, 'owner') or ''
      local lease = tonumber(redis.call('HGET', fanout, 'lease') or '0') or 0
      if owner ~= '' and owner ~= ARGV[1] and lease > now then
        return { '${BUSY}', owner, tostring(lease) }
      end

      local reclaimed = '0'
      if owner ~= '' and owner ~= ARGV[1] then
        reclaimed = '1'
      end

      redis.call('HSET', fanout, 'owner', ARGV[1], 'lease', tostring(now + leaseMs))
      local attempts = redis.call('HINCRBY', fanout, 'att', 1)

      -- The fence token for this claim. Monotonic, minted here and RETURNED rather than
      -- supplied, so a replayed claim simply mints a fresh one and the caller acts on the
      -- reply it actually received. Every later transition for this claim quotes it, which
      -- is what makes those transitions replay-safe without appealing to ownership — the
      -- ack deliberately clears the owner, so ownership cannot fence what follows it.
      local epoch = tostring(redis.call('HINCRBY', fanout, 'ep', 1))

      -- LRANGE with a computed stop index: the page bound is structural. HSCAN would put
      -- the bound at the mercy of hash-max-listpack-entries, which hands back a whole
      -- small hash in one reply however low COUNT is set.
      local page = redis.call('LRANGE', queue, 0, pageSize - 1)

      local out = {
        '${CLAIMED}',
        redis.call('HGET', record, 'c') or '',
        reclaimed,
        tostring(attempts),
        redis.call('HGET', fanout, 'cAt') or '0',
        redis.call('HGET', fanout, 'fail') or '0',
        epoch,
        redis.call('HGET', record, 'cbt') or '',
        tostring(#page)
      }
      for i = 1, #page do
        out[#out + 1] = page[i]
        -- false for a watcher unregistered since it was queued. It arrives as '' and the
        -- worker skips it as stale rather than delivering to a run that will not resume.
        out[#out + 1] = redis.call('HGET', watchers, page[i]) or ''
      end

      -- Immutable metadata is returned in the same atomic read as the completion.
      out[#out + 1] = redis.call('HGET', record, 'r') or ''
      return out
    `,
  });

  /**
   * KEYS: record, watchers, queue, fanout.
   * ARGV: workerId, epoch, count, nowMs, terminalTtlMs.
   *
   * Acknowledge `count` watchers from the head of the queue, fenced by the claim's epoch.
   *
   * The trim is applied at most ONCE per epoch. ioredis resends an unfulfilled command
   * whose reply was lost after Redis had already run it, so this script must expect to see
   * the identical call twice; a second LTRIM would retire a second, wholly undelivered
   * prefix, which is a silent lost wake-up for every watcher in it. `ackEp` records the
   * epoch whose trim has landed, and a replay takes the derive-only path.
   *
   * A replay must also leave the CLAIM alone. By the time one arrives another worker may
   * hold the entry, and re-clearing the owner would strip a live claim. Only the first
   * application clears it.
   *
   * An epoch that is neither the current one nor the applied one belongs to a claim that
   * has since been superseded: that worker's page has been reissued to someone else and its
   * ack is refused.
   *
   * Draining the last page is the moment the waitpoint has no lifecycle obligation left, so
   * it is also the only place the terminal TTL is armed for a waitpoint that had watchers.
   */
  redis.defineCommand("wpFanoutAck", {
    numberOfKeys: 4,
    lua: `
      local record, watchers, queue, fanout = KEYS[1], KEYS[2], KEYS[3], KEYS[4]

      local count = tonumber(ARGV[3])
      local ttl = tonumber(ARGV[5])
      if ARGV[2] == '' then
        return redis.error_reply('wpFanoutAck: ARGV[2] must be a claim epoch')
      end
      if count == nil or count < 0 then
        return redis.error_reply('wpFanoutAck: ARGV[3] must be a non-negative count')
      end
      if ttl == nil or ttl <= 0 then
        return redis.error_reply('wpFanoutAck: ARGV[5] must be a positive TTL in ms')
      end

      if redis.call('EXISTS', fanout) == 0 then
        return { '${ABSENT}' }
      end

      -- Already drained, by this ack's first application or by another worker. Returning
      -- without rewriting keeps a replay from re-arming the terminal window from now.
      if redis.call('HGET', fanout, 'state') == 'done' then
        return { '${DRAINED}', redis.call('HGET', fanout, 'del') or '0' }
      end

      local applied = redis.call('HGET', fanout, 'ackEp') or '0'
      if applied ~= ARGV[2] then
        if tostring(redis.call('HGET', fanout, 'ep') or '0') ~= ARGV[2] then
          -- A superseded claim. Its page has been reissued, so trimming on its behalf would
          -- retire watchers the new owner is about to deliver to.
          return { '${LOST}', redis.call('HGET', fanout, 'owner') or '' }
        end

        if count > 0 then
          redis.call('LTRIM', queue, count, -1)
          redis.call('HINCRBY', fanout, 'del', count)
          -- Progress resets the failure streak AND the delay it earned. Retries are bounded
          -- per stall, not per waitpoint: a wide fan-out legitimately takes many pages, and
          -- counting those towards the give-up threshold would quarantine a healthy drain.
          redis.call('HSET', fanout, 'fail', '0', 'nb', ARGV[4])
        end

        redis.call('HSET', fanout, 'ackEp', ARGV[2])
        -- Only the first application releases the claim. A replay may arrive after another
        -- worker has taken the entry, and clearing the owner then would strip a live claim.
        redis.call('HSET', fanout, 'owner', '', 'lease', '0')
      end

      -- Derived, not remembered. Every branch below is idempotent, so a replay reaches the
      -- same answer from the state the first application left behind.
      local remaining = redis.call('LLEN', queue)
      if remaining > 0 then
        return { '${MORE}', tostring(remaining) }
      end

      redis.call('HSET', fanout, 'state', 'done', 'doneAt', ARGV[4])
      -- Compact the watcher state. Every delivery is durable on its own run's shard and
      -- nothing registers against a COMPLETED waitpoint, so these two keys have no reader
      -- left.
      redis.call('DEL', queue, watchers)
      redis.call('PEXPIRE', fanout, ttl)
${RETAIN_WAITPOINT_RECORD}

      return { '${DRAINED}', redis.call('HGET', fanout, 'del') or '0' }
    `,
  });

  /**
   * KEYS: fanout. ARGV: workerId, epoch, nowMs, action ('yield'|'fail'), maxFailures.
   *
   * Give the claim back without acknowledging, so the entry is reclaimable at once. Fenced
   * by the claim's epoch, not by ownership: a `fail` legitimately follows a partial ack,
   * and that ack has already cleared the owner.
   *
   *  - `yield` — the visit's page budget is spent with work left. Not a failure, and
   *    clearing an already-cleared claim is idempotent, so this needs no applied-marker.
   *  - `fail` — a delivery could not be completed. Increments the CONSECUTIVE failure
   *    streak and, in the SAME atomic step, parks the entry for intervention once the
   *    streak reaches `maxFailures`.
   *
   * The threshold lives here rather than in the caller because the decision has to be
   * inseparable from the increment and from the fence. Splitting it left a window in which
   * another worker could claim the entry between a caller's release and its follow-up
   * quarantine, so the quarantine applied to an entry someone else now owned.
   *
   * `failEp` records the epoch whose failure has been counted, so a resent command — ioredis
   * replays one whose reply was lost after Redis ran it — reports the same streak and the
   * same transition instead of counting the stall twice and quarantining early.
   *
   * Quarantining deliberately arms no TTL: unresolved recovery state must not disappear on
   * its own.
   */
  redis.defineCommand("wpFanoutRelease", {
    numberOfKeys: 1,
    lua: `
      local fanout = KEYS[1]

      -- Guard before any write: an unknown action must not clear a live claim.
      if ARGV[4] ~= 'yield' and ARGV[4] ~= 'fail' then
        return redis.error_reply('wpFanoutRelease: ARGV[4] must be yield or fail')
      end
      if ARGV[2] == '' then
        return redis.error_reply('wpFanoutRelease: ARGV[2] must be a claim epoch')
      end
      local maxFailures = tonumber(ARGV[5])
      local baseDelayMs = tonumber(ARGV[6])
      local maxDelayMs = tonumber(ARGV[7])
      if ARGV[4] == 'fail' then
        if maxFailures == nil or maxFailures < 1 then
          return redis.error_reply('wpFanoutRelease: fail requires a maxFailures >= 1')
        end
        if baseDelayMs == nil or maxDelayMs == nil or baseDelayMs < 1 or maxDelayMs < baseDelayMs then
          return redis.error_reply('wpFanoutRelease: fail requires 1 <= baseDelayMs <= maxDelayMs')
        end
        if tonumber(ARGV[3]) == nil then
          return redis.error_reply('wpFanoutRelease: fail requires a numeric nowMs')
        end
      end

      if redis.call('EXISTS', fanout) == 0 then
        return { '${ABSENT}' }
      end

      local applied = redis.call('HGET', fanout, 'failEp') or '0'
      if ARGV[4] == 'fail' and applied == ARGV[2] then
        -- A resent command. Report what the first application decided; count nothing, and
        -- move nothing — including the notBefore it computed.
        local failures = redis.call('HGET', fanout, 'fail') or '0'
        local notBefore = redis.call('HGET', fanout, 'nb') or '0'
        if redis.call('HGET', fanout, 'state') == 'quarantined' then
          return { '${QUARANTINED}', failures, notBefore }
        end
        return { '${RELEASED}', failures, notBefore }
      end

      -- The fence gates the increment AND the transition. A worker whose claim has been
      -- superseded must not count a failure against, or quarantine, an entry someone else
      -- now holds. The epoch subsumes an owner comparison, because a different owner can
      -- only have arrived through a claim that raised the epoch; the owner is read purely
      -- for the reply.
      if tostring(redis.call('HGET', fanout, 'ep') or '0') ~= ARGV[2] then
        return { '${LOST}', redis.call('HGET', fanout, 'owner') or '' }
      end

      redis.call('HSET', fanout, 'owner', '', 'lease', '0')

      if ARGV[4] == 'yield' then
        -- A yield is not a failure, so it neither counts nor delays. The entry stays due.
        return { '${RELEASED}', redis.call('HGET', fanout, 'fail') or '0',
                 redis.call('HGET', fanout, 'nb') or '0' }
      end

      local failures = redis.call('HINCRBY', fanout, 'fail', 1)
      redis.call('HSET', fanout, 'failEp', ARGV[2])

      if failures >= maxFailures then
        redis.call('HSET', fanout, 'state', 'quarantined', 'qAt', ARGV[3])
        return { '${QUARANTINED}', tostring(failures), redis.call('HGET', fanout, 'nb') or '0' }
      end

      -- Mirrors fanoutRetryDelayMs in fanoutPolicy.ts, which stays the definition of this
      -- curve and is pinned against this arithmetic by a test. Computed here because the
      -- delay has to be inseparable from the increment that produced it.
      local grown = baseDelayMs
      if failures > 1 then
        grown = baseDelayMs * 2 ^ (failures - 1)
      end
      local delay = math.floor(math.min(maxDelayMs, grown))
      local notBefore = tonumber(ARGV[3]) + delay
      redis.call('HSET', fanout, 'nb', tostring(notBefore))

      return { '${RELEASED}', tostring(failures), tostring(notBefore) }
    `,
  });

  /**
   * KEYS: record, watchers. ARGV: watcherField.
   *
   * Drop one watcher registration, so a completed waitpoint stops fanning out to a run that
   * has been cancelled or has gone terminal.
   *
   * The paging queue is left alone on purpose: removing a field from the middle of a list is
   * O(n) in the watcher count, the exact cost this work exists to remove. The worker
   * resolves each queued field against this hash and skips the ones that are gone.
   */
  redis.defineCommand("wpUnregisterWatcher", {
    numberOfKeys: 2,
    lua: `
      local record, watchers = KEYS[1], KEYS[2]

      -- A vanished record is not an error here. Unregistration is cleanup, it runs after
      -- the fact, and a terminal record may already have expired.
      if redis.call('EXISTS', record) == 0 then
        return { '${MISSING}' }
      end

      if redis.call('HDEL', watchers, ARGV[1]) == 1 then
        return { '${UNREGISTERED}' }
      end

      return { '${ABSENT}' }
    `,
  });

  /**
   * KEYS: record, watchers, queue, fanout.
   *
   * Read-only diagnostics for one waitpoint. Returns counts, never the watcher set.
   */
  redis.defineCommand("wpDescribe", {
    numberOfKeys: 4,
    lua: `
      local record, watchers, queue, fanout = KEYS[1], KEYS[2], KEYS[3], KEYS[4]

      if redis.call('EXISTS', record) == 0 then
        return { '${MISSING}' }
      end

      local f = redis.call('HMGET', fanout, 'state', 'owner', 'lease', 'att', 'cAt', 'del', 'fail')

      return {
        '${EXISTS}',
        redis.call('HGET', record, 'status') or '',
        tostring(redis.call('PTTL', record)),
        tostring(redis.call('HLEN', watchers)),
        tostring(redis.call('LLEN', queue)),
        f[1] or '${ABSENT}', f[2] or '', f[3] or '0', f[4] or '0', f[5] or '0', f[6] or '0',
        f[7] or '0'
      }
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

  // KEYS: record, watchers, queue, fanout. No ARGV. Discards a losing reservation's
  // orphan record, including any watcher or fanout state it managed to acquire.
  redis.defineCommand("wpDiscard", {
    numberOfKeys: 4,
    lua: `
      redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
      return { '${DISCARDED}' }
    `,
  });

  /**
   * KEYS: due index, quarantine index. ARGV: op, waitpointId, scoreMs, limit.
   *
   * The fanout discovery index. Every operation is a script, so every operation is an
   * EVAL, which a cluster client always routes to the slot's primary — a bare
   * ZRANGEBYSCORE is eligible for a replica read under `scaleReads`, and a replica's view
   * of what work is owed is exactly the kind of stale authoritative read this protocol
   * must not make.
   *
   * ops: add (unconditional — only for a caller that just created the work) · add-nx (file
   * only if absent) · reschedule (fenced: never adds, never lowers) · repair (never adds,
   * may lower — only for a value just read from the fanout entry) · remove · due (bounded
   * page of ids at or before scoreMs) · quarantine (atomically move from due to quarantine)
   * · stats (cardinality plus oldest score).
   */
  redis.defineCommand("wpFanoutIndex", {
    numberOfKeys: 2,
    lua: `
      local due, quarantine = KEYS[1], KEYS[2]
      local op = ARGV[1]

      if op == 'add' then
        local score = tonumber(ARGV[3])
        if score == nil then
          return redis.error_reply('wpFanoutIndex add: ARGV[3] must be numeric')
        end
        redis.call('ZADD', due, score, ARGV[2])
        return { 'added' }
      end

      if op == 'repair' then
        local score = tonumber(ARGV[3])
        if score == nil then
          return redis.error_reply('wpFanoutIndex repair: ARGV[3] must be numeric')
        end
        -- XX without GT. The caller read this value out of the fanout entry in the same
        -- round trip, so it is authoritative in BOTH directions and may lower the score;
        -- the entry's own notBefore is what actually gates a claim, so an index score that
        -- ends up early costs a wasted probe and nothing more. XX still refuses to add, so
        -- a repair cannot resurrect an entry another worker retired.
        redis.call('ZADD', due, 'XX', score, ARGV[2])
        return { 'repaired' }
      end

      if op == 'reschedule' then
        local score = tonumber(ARGV[3])
        if score == nil then
          return redis.error_reply('wpFanoutIndex reschedule: ARGV[3] must be numeric')
        end
        -- XX GT, and both halves are load-bearing. The index is on a different slot from
        -- the fanout entry whose state justified this write, so a worker can always be
        -- overtaken between deciding and writing.
        --
        --   XX  never ADDS. A worker that decided while holding a claim another worker has
        --       since drained cannot resurrect a retired hint.
        --   GT  never LOWERS. It cannot pull a newer owner's retry schedule earlier, and it
        --       cannot undo a backoff that was installed after this worker read the entry.
        --
        -- Raising a past score to the current time still leaves the entry immediately due,
        -- so a clean yield continues promptly.
        redis.call('ZADD', due, 'XX', 'GT', score, ARGV[2])
        return { 'rescheduled' }
      end

      if op == 'add-nx' then
        local score = tonumber(ARGV[3])
        if score == nil then
          return redis.error_reply('wpFanoutIndex add-nx: ARGV[3] must be numeric')
        end
        -- NX: file a hint that is missing, and never move one that is already there. A
        -- pending fanout's score is its retry schedule, and a duplicate completion pulling
        -- it earlier would run failed deliveries at poll speed instead of at the backoff.
        redis.call('ZADD', due, 'NX', score, ARGV[2])
        return { 'added' }
      end

      if op == 'remove' then
        return { 'removed', tostring(redis.call('ZREM', due, ARGV[2])) }
      end

      if op == 'due' then
        local score = tonumber(ARGV[3])
        local limit = tonumber(ARGV[4])
        if score == nil or limit == nil or limit < 1 then
          return redis.error_reply('wpFanoutIndex due: a numeric score and a limit >= 1 are required')
        end
        -- LIMIT, always: the reply size is the caller's page bound, not the backlog depth.
        local ids = redis.call('ZRANGEBYSCORE', due, '-inf', score, 'LIMIT', 0, limit)
        local out = { 'due', tostring(#ids) }
        for i = 1, #ids do out[#out + 1] = ids[i] end
        return out
      end

      if op == 'quarantine' then
        local score = tonumber(ARGV[3])
        if score == nil then
          return redis.error_reply('wpFanoutIndex quarantine: ARGV[3] must be numeric')
        end
        redis.call('ZREM', due, ARGV[2])
        -- No TTL on this index, and none on the entries it names: work nobody has resolved
        -- is exactly what must still be here tomorrow.
        redis.call('ZADD', quarantine, score, ARGV[2])
        return { 'quarantined' }
      end

      if op == 'stats' then
        local oldest = redis.call('ZRANGE', due, 0, 0, 'WITHSCORES')
        return {
          'stats',
          tostring(redis.call('ZCARD', due)),
          oldest[2] or '',
          tostring(redis.call('ZCARD', quarantine))
        }
      end

      return redis.error_reply('wpFanoutIndex: unknown op ' .. tostring(op))
    `,
  });

  // Bounded admission read for legacy-only edges. The caller holds the run lock through the
  // subsequent Postgres write, serializing it with cleanup-fence installation and replay.
  redis.defineCommand("runReadCleanupFence", {
    numberOfKeys: 1,
    lua: `return { redis.call('HGET', KEYS[1], 'co') or '' }`,
  });

  /**
   * KEYS: pend, done, edge, st.
   * ARGV: blockId, n, then n groups of 5 — waitpointId, edgeField, edgeJson, reportedFlag
   * ('1'|'0'), reportedJson (''). reportedFlag, not the emptiness of reportedJson, is what
   * decides the branch: a waitpoint can be reported COMPLETED with no completion envelope
   * (see the FINISHED-healing path), and that case must still take the reported branch —
   * flag '1', reportedJson '' — or the run would block forever on something already done.
   *
   * Installing `blockId` is what makes a delivery attributable to one block operation.
   *
   * A DIFFERENT block id is a cycle ROLLOVER: the previous cycle's pending ids, receipts and
   * edges are all removed before this cycle's are installed. Leaving them would let
   * `runReadBlockState` hand a caller the previous cycle's completion data, and the ordered
   * references a resume is built from come from that edge set. Nothing is carried across,
   * because a receipt carries no block id and there is no way to tell whose it is.
   *
   * Receipts survive in exactly two cases, neither of which is a rollover. With NO previous
   * block installed, a receipt is a genuine early delivery and the loop below subtracts it.
   * With the SAME block id, this is a retry: edges, first-written metadata and receipts are
   * all preserved and the handoff state is left alone.
   *
   * The caller therefore owes a fresh id per block operation.
   */
  redis.defineCommand("runAbsorbBlockers", {
    numberOfKeys: 14,
    lua: `
      local pend, done, edge, st, contrib, results = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6]
      local n = tonumber(ARGV[4])
      local edgeIndex, doneOrder, early, earlyOrder = KEYS[8], KEYS[9], KEYS[10], KEYS[11]
      local wd, targets = KEYS[12], KEYS[13]

      -- Guard before any write: a wrong n must not half-apply the script. HDEL/HSETNX below
      -- are irreversible mid-script, and Redis does not roll back a script that errors. The trailing
      -- ARGV carries the absorption id, index member and read revision after the edge groups.
      if n == nil or (#ARGV ~= 8 + n * 5 and #ARGV ~= 7 + n * 5) then
        return redis.error_reply('runAbsorbBlockers: arity mismatch')
      end
      local evidenceOffset = #ARGV == 8 + n * 5 and 3 or 2
      if ARGV[1] == '' then
        return redis.error_reply('runAbsorbBlockers: ARGV[1] must be a block id')
      end
      if ARGV[2] ~= '0' and ARGV[2] ~= '1' then
        return redis.error_reply('runAbsorbBlockers: ARGV[2] must be an expectation flag')
      end

      -- The COMPARE-AND-SET, before PERSIST and before any other write, because a rejection
      -- must mutate nothing at all — and PERSIST is a mutation, it clears a terminal TTL.
      local previous = redis.call('HGET', st, 'blk') or ''
      local expectsPrevious = ARGV[2] == '1'
      local expected = ARGV[3]

      if redis.call('HGET', st, 'term') == '1' then
        return { '${TERMINAL}', previous }
      end

      -- The cleanup-owed fence: a previous mixed block still owes its cross-store cleanup (its block-id-less
      -- Postgres delete plus store withdrawal). A DIFFERENT block must not become active until that clears,
      -- or a delayed B1 cleanup could delete a reused B2 legacy edge. A same-block operation (an idempotent
      -- retry of the fenced block itself) is not blocked; the higher layer's cycle-anchor precondition
      -- fences a genuine delayed replay of it.
      local cleanupOwed = redis.call('HGET', st, 'co') or ''
      if cleanupOwed ~= '' and cleanupOwed ~= ARGV[1] then
        return { '${CLEANUP_OWED}', cleanupOwed }
      end

      -- Block ids are random, so they carry no order and cannot be compared. The caller names
      -- the predecessor it believes it is replacing instead, which is what makes a delayed
      -- retry of an older operation distinguishable from a legitimate rollover.
      local isRetry = previous ~= '' and previous == ARGV[1]
      local isRollover = expectsPrevious and previous ~= '' and previous == expected
      local isFirst = not expectsPrevious and previous == ''

      if not (isRetry or isRollover or isFirst) then
        return { '${STALE}', previous }
      end
      -- Validate the declared predecessor's retained keys before any mutation. Rollover moves the
      -- hash instead of enumerating it; the manifest survives a lost reply and empty old blocks.
      if isRollover and (redis.call('EXISTS', wd, targets) > 0) then
        return redis.error_reply('runAbsorbBlockers: predecessor withdrawal already retained')
      end
${PERSIST_RUN_KEYS}
      for i = 7, 11 do redis.call('PERSIST', KEYS[i]) end
      redis.call('PERSIST', results)
      local supersededBlock = ''
      if isRollover then
        redis.call('SET', wd, previous)
        if redis.call('EXISTS', edge) == 1 then redis.call('RENAME', edge, targets) end
        redis.call('PERSIST', targets)
        redis.call('UNLINK', pend, done, KEYS[7], edgeIndex, doneOrder, early, earlyOrder)
      end
      -- Retry discovery is independent of the fresh-rollover branch.
      if expectsPrevious and redis.call('GET', wd) == expected then supersededBlock = expected end
      redis.call('HSET', st, 'rev', ARGV[#ARGV])
      if not isRetry then redis.call('HSET', st, 'blk', ARGV[1], 'hs', '') end
      if evidenceOffset == 3 and ARGV[#ARGV - evidenceOffset] ~= '' then
        redis.call('SADD', contrib, '!accepted', ARGV[#ARGV - 1])
        redis.call('ZADD', KEYS[14], 0, ARGV[#ARGV - evidenceOffset + 1])
      end
      local requestedIds = {}
      local seenDelivered = {}
      -- Keep the old field-count slot at zero; targets are read only in hard-bounded pages.
      local out = { '${ABSORBED}', '0', '0', supersededBlock, '0' }

      for i = 0, n - 1 do
        local id           = ARGV[5 + i * 5]
        local field        = ARGV[6 + i * 5]
        local edgeJson     = ARGV[7 + i * 5]
        local reportedFlag = ARGV[8 + i * 5]
        local reported     = ARGV[9 + i * 5]

        -- Preserve the first edge metadata, but count each operation's claim separately.
        -- A failed earlier operation must not remove an edge adopted by a later one.
        local inserted = redis.call('HSETNX', edge, field, edgeJson)
        if inserted == 1 then
          redis.call('HINCRBY', KEYS[7], id, 1)
          redis.call('ZADD', edgeIndex, redis.call('HINCRBY', st, 'edgeSeq', 1), field)
        end
        local claimField = '!' .. field
        if ARGV[#ARGV - evidenceOffset] ~= '' then
          if redis.call('SISMEMBER', contrib, '!registered') == 0 and redis.call('SADD', contrib, field) == 1 then
            -- Existing edges without claim counts predate this protocol or have no operation ID.
            if inserted == 0 then redis.call('HSETNX', KEYS[7], claimField, 1) end
            if redis.call('HGET', KEYS[7], claimField) ~= '-1' then
              redis.call('HINCRBY', KEYS[7], claimField, 1)
            end
            redis.call('ZADD', KEYS[14], 0, ARGV[#ARGV - evidenceOffset + 1])
          end
        else
          -- Calls without an operation ID have no compensation path. Keep their claim until cleanup.
          redis.call('HSET', KEYS[7], claimField, -1)
        end
        requestedIds[id] = true
        -- Adopt the first early receipt before considering a reported completion. Its ordinal and
        -- envelope are immutable; moving it invalidates the structural read revision above.
        local earlyReceipt = redis.call('HGET', early, id)
        if earlyReceipt then
          if redis.call('HSETNX', done, id, earlyReceipt) == 1 then
            redis.call('ZADD', doneOrder, redis.call('ZSCORE', earlyOrder, id), id)
          end
          redis.call('HDEL', early, id)
          redis.call('ZREM', earlyOrder, id)
        end

        if reportedFlag == '1' then
          -- Already COMPLETED when the watcher registered. It never becomes pending, even
          -- when reported ('' here) carries no envelope.
          --
          -- HSETNX, not HSET: a fanout delivery that raced ahead of this absorb has
          -- already written the frozen envelope, and this branch's reported value may be ''.
          -- Overwriting would trade a real envelope for an empty one.
          if redis.call('HSETNX', done, id, reported) == 1 then
            redis.call('ZADD', doneOrder, redis.call('HINCRBY', st, 'seq', 1), id)
          end
          -- Retain the snapshot result in the same fenced commit as the active block. A source
          -- captured before absorption can expire immediately without erasing the accepted result.
          redis.call('HSETNX', results, id, redis.call('HGET', done, id))
          redis.call('SREM', pend, id)
          if not seenDelivered[id] then
            seenDelivered[id] = true
            out[#out + 1] = id
            out[#out + 1] = redis.call('HGET', done, id) or ''
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

      local remaining = redis.call('SCARD', pend)
      -- An already-completed source can finish this block during absorption, before registration.
      -- Preserve the same durable handoff obligation as delivery, without re-arming an acknowledged
      -- cycle or making an empty block with no completion receipts owe a resume.
      if remaining == 0 and (redis.call('HLEN', done) + redis.call('HLEN', early)) > 0 and redis.call('HGET', st, 'hs') ~= 'ack' then
        redis.call('HSET', st, 'hs', 'owed')
      end
      out[2] = tostring(pendingOfRequested)
      out[3] = tostring(remaining)
      return out
    `,
  });

  /**
   * KEYS: pend, done, st. ARGV: blockId, waitpointId, completionJson.
   *
   * The idempotent run-side effect of a completion, and the only place a run's pending set
   * shrinks by delivery.
   *
   * Four refusals matter:
   *
   *  - `terminal` — the run has been through terminal cleanup. Writing a receipt now would
   *    resurrect a reclaimed partition with keys carrying no TTL.
   *  - `acked` — this block's resume transition is already durable. The cycle is finished,
   *    so a late duplicate must not re-arm the handoff, signal resumability again, or
   *    recreate the receipts the acknowledgement drained.
   *  - `stale` — the run's current block id is not the one this delivery was registered
   *    under. The completion belongs to a block operation that is over; clearing a pending
   *    id, or signalling resumability for the CURRENT block on its behalf, would wake a run
   *    whose blockers are not met.
   *  - an ABSENT block id is NOT stale. That is a completion arriving before its blockers
   *    were absorbed, and the receipt has to survive for runAbsorbBlockers to subtract it.
   *
   * HSETNX, so a redelivery is visibly a duplicate, cannot rewrite a frozen receipt, and
   * cannot signal a resume the fresh delivery has already signalled.
   *
   * Production registration/fanout requires the current block: absorption always precedes watcher
   * publication. This also refuses delayed work after terminal state expires. Explicit primitive
   * early delivery may omit that requirement when the caller owns a subsequent absorption.
   */
  redis.defineCommand("runDeliverCompletion", {
    numberOfKeys: 8,
    lua: `
      local pend, done, st, results = KEYS[1], KEYS[2], KEYS[3], KEYS[4]

      if redis.call('HGET', st, 'term') == '1' then
        return { '${TERMINAL}', '0', '0', '' }
      end

      local current = redis.call('HGET', st, 'blk')
      if ARGV[4] == '1' and (not current or current == '') then
        return { '${STALE}', '0', '0', '' }
      end
      if current and current ~= '' and current ~= ARGV[1] then
        return { '${STALE}', tostring(redis.call('SCARD', pend)), '0', current }
      end

      -- This block's resume has already been durably accepted. Re-arming the obligation
      -- would signal a second resume for a cycle that is finished, and writing a receipt
      -- would recreate state the acknowledgement drained on purpose.
      if current == ARGV[1] and redis.call('HGET', st, 'hs') == 'ack' then
        return { '${ACKED}', tostring(redis.call('SCARD', pend)), '0', current }
      end

      local receipts, order = done, KEYS[6]
      if redis.call('HEXISTS', KEYS[5], ARGV[2]) == 0 then receipts, order = KEYS[7], KEYS[8] end
      -- Initialize a fresh epoch after absence/expiry, but ongoing deliveries do not invalidate a
      -- read. Its captured seq reconstructs pending-at-start even after SREM below.
      redis.call('HSETNX', st, 'rev', ARGV[5])
      local fresh = redis.call('HSETNX', receipts, ARGV[2], ARGV[3])
      if fresh == 1 then redis.call('ZADD', order, redis.call('HINCRBY', st, 'seq', 1), ARGV[2]) end
      -- The snapshot result and active receipt commit together, after all block/terminal
      -- fences. Immutable waitpoint IDs make replay and later cycles unable to rewrite a result.
      redis.call('HSETNX', results, ARGV[2], redis.call('HGET', receipts, ARGV[2]))
      redis.call('SREM', pend, ARGV[2])
      local remaining = redis.call('SCARD', pend)

      -- Resumability is a fact about the CURRENT block, signalled EXACTLY ONCE: only the
      -- fresh delivery that empties the pending set may claim it. Delivery is at-least-once,
      -- so a redelivery arriving before the handoff is acknowledged would otherwise find the
      -- set already empty and signal a second resume for the same block. An early delivery,
      -- with no block id installed yet, also leaves remaining at 0 and must not be read as
      -- "every blocker is met".
      local resumable = '0'
      if fresh == 1 and current == ARGV[1] and remaining == 0 then
        -- From here the run owes TRES a durable resume transition, and its receipts may not
        -- be reclaimed until that transition is acknowledged.
        redis.call('HSET', st, 'hs', 'owed')
        resumable = '1'
      end

      local outcome = '${DUPLICATE}'
      if fresh == 1 then outcome = '${DELIVERED}' end
      return { outcome, tostring(remaining), resumable, current or '' }
    `,
  });

  /**
   * KEYS: st. ARGV: blockId.
   *
   * The TRES durability boundary, coordinator-side. Called once the resumed transition is
   * durable; until then the run's receipts are retained and terminal TTL is refused.
   *
   * Marked before the edges are drained, never after. A crash between the two leaves
   * receipts that the next absorb's reconcile or terminal cleanup removes; the reverse
   * order would leave an obligation nothing can ever discharge, and a run partition that
   * never becomes reclaimable.
   */
  redis.defineCommand("runMarkHandoffAcked", {
    numberOfKeys: 1,
    lua: `
      local st = KEYS[1]

      local current = redis.call('HGET', st, 'blk')
      if not current or current == '' then
        return { '${UNKNOWN}' }
      end
      if current ~= ARGV[1] then
        return { '${STALE}', current }
      end

      redis.call('HSET', st, 'hs', 'ack', 'rev', ARGV[2])
      return { '${ACKNOWLEDGED}' }
    `,
  });

  /**
   * KEYS: pend, done, edge, st. ARGV: nowMs, terminalTtlMs, voidHandoff ('1'|'0').
   *
   * Arm the terminal retention window on a run's coordination state, and only then.
   *
   * With an outstanding handoff obligation and voidHandoff '0' this refuses and changes
   * nothing: the run has every blocker met but TRES has not durably accepted the resume, so
   * reclaiming the receipts now is the lost wake-up the lifecycle exists to prevent.
   *
   * voidHandoff '1' is for cancellation and terminal completion, where no resume transition
   * will ever be published — the obligation is discharged by the run's own outcome, not
   * abandoned. State is expired, never deleted, so receipts stay readable for the window.
   */
  redis.defineCommand("runTerminalCleanup", {
    numberOfKeys: 10,
    lua: `
      local st = KEYS[4]

      local ttl = tonumber(ARGV[2])
      if ttl == nil or ttl <= 0 then
        return redis.error_reply('runTerminalCleanup: ARGV[2] must be a positive TTL in ms')
      end

      -- A run with no coordination state at all is a no-op, not a tombstone. Writing one
      -- per terminal run would cost a key carrying a fortnight's TTL for every run in the
      -- system, and a run that never absorbed a blocker has no receipt to protect.
      if redis.call('EXISTS', KEYS[1], KEYS[2], KEYS[3], KEYS[4]) == 0 and
         (ARGV[3] ~= '1' or redis.call('EXISTS', KEYS[5]) == 0) then
        return { '${ARMED}', '', 'absent' }
      end

      local hs = redis.call('HGET', st, 'hs') or ''
      if hs == 'owed' and ARGV[3] ~= '1' then
        return { '${RETAINED}', 'handoff-owed' }
      end

      redis.call('HSET', st, 'term', '1', 'hs', '', 'termAt', ARGV[1], 'rev', ARGV[4])
      for i = 1, 4 do redis.call('PEXPIRE', KEYS[i], ttl) end
      for i = 6, 10 do redis.call('PEXPIRE', KEYS[i], ttl) end
      -- Resume is not result consumption. Only the run's terminal lifecycle arms this TTL.
      if ARGV[3] == '1' then redis.call('PEXPIRE', KEYS[5], ttl) end

      return { '${ARMED}', hs, 'present' }
    `,
  });

  /**
   * KEYS: edge, st, edgeIndex, doneOrder, earlyOrder.
   * ARGV: start|page, structural revision, completion cutoff, edge offset, last early ordinal.
   * A snapshot is (rev, seq): membership/deletion changes rev; fresh immutable receipts only advance
   * seq. Pages therefore reconstruct statuses at start without restarting for ordinary fanout.
   */
  redis.defineCommand("runReadBlockState", {
    numberOfKeys: 5,
    lua: `
      local edge, st, edgeIndex, doneOrder, earlyOrder = unpack(KEYS)
      local state = redis.call('HMGET', st, 'rev', 'seq', 'blk', 'hs', 'term')
      local revision = state[1] or ''
      local cutoff = tonumber(ARGV[3]) or 0
      if ARGV[1] == 'start' then cutoff = tonumber(state[2]) or 0
      elseif revision ~= ARGV[2] then return { '${STALE}' } end
      local edgeOffset = tonumber(ARGV[4])
      local earlyAfter = ARGV[5] == '' and '-inf' or '(' .. ARGV[5]
      local fields = redis.call('ZRANGE', edgeIndex, edgeOffset, edgeOffset + ${RUN_CLEANUP_PAGE_SIZE} - 1)
      local earlyIds = redis.call('ZRANGEBYSCORE', earlyOrder, earlyAfter, cutoff, 'WITHSCORES', 'LIMIT', 0, ${RUN_CLEANUP_PAGE_SIZE})
      local out = { 'page', revision, tostring(cutoff), state[3] or '', state[4] or '', state[5] or '', tostring(#fields), tostring(#earlyIds / 2) }
      for i = 1, #fields do
        local field = fields[i]
        local sep = string.find(field, '#[^#]*$')
        local id = string.sub(field, 1, sep - 1)
        local ordinal = tonumber(redis.call('ZSCORE', doneOrder, id))
        out[#out + 1] = field
        out[#out + 1] = redis.call('HGET', edge, field) or ''
        out[#out + 1] = ordinal and ordinal <= cutoff and '1' or '0'
      end
      for i = 1, #earlyIds do out[#out + 1] = earlyIds[i] end
      return out
    `,
  });

  // KEYS: pend, done, edge, st, refs. ARGV: blockId, n, then n edge fields.
  // n = 0 unlinks the full active partition, including co; the exact-block CAS still applies.
  // Only callers that already own lifecycle/legacy cleanup may use full-clear. Retry cleanup uses
  // retain-and-clear plus finalizeRetainedWithdrawal so its cross-store fence survives interruption.
  redis.defineCommand("runClear", {
    numberOfKeys: 9,
    lua: `
      local pend, done, edge, st = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
      local n = tonumber(ARGV[2])

      -- Guard before any write, same reasoning as runAbsorbBlockers.
      if n == nil or #ARGV ~= 3 + n or n > ${RUN_CLEANUP_PAGE_SIZE} then
        return redis.error_reply('runClear: arity mismatch')
      end
      if ARGV[1] == '' then
        return redis.error_reply('runClear: ARGV[1] must be the expected block id')
      end

      -- The COMPARE-AND-SET, in the same invocation as the mutation it guards. Every clear
      -- here is destructive, and a drain is issued as a SECOND call after an acknowledgement
      -- fenced only the first: a rollover landing in between would otherwise have block 2's
      -- state deleted by block 1's late drain. Edge identity cannot be the fence, because
      -- block 2 may reuse block 1's exact edge fields.
      local current = redis.call('HGET', st, 'blk') or ''

      if redis.call('HGET', st, 'term') == '1' then
        return { '${TERMINAL}', current }
      end
      if current ~= ARGV[1] then
        return { '${STALE}', current }
      end

      if n == 0 then
        redis.call('UNLINK', unpack(KEYS))
        return { '${CLEARED}', current }
      end

      redis.call('HSET', st, 'rev', ARGV[#ARGV])
      for i = 1, n do
        local field = ARGV[2 + i]
        if redis.call('HDEL', edge, field) == 1 then
          redis.call('HDEL', KEYS[5], '!' .. field)
          redis.call('ZREM', KEYS[6], field)
          local sep = string.find(field, '#[^#]*$')
          if sep then
            local id = string.sub(field, 1, sep - 1)
            if redis.call('HINCRBY', KEYS[5], id, -1) <= 0 then
              redis.call('HDEL', KEYS[5], id)
              redis.call('HDEL', done, id)
              redis.call('ZREM', KEYS[7], id)
              redis.call('SREM', pend, id)
            end
          end
        end
      end

      -- Every unreferenced receipt is isolated here. Detach them all just as the old full-parent
      -- reconciliation did, while references above preserve another batch index's receipt.
      redis.call('UNLINK', KEYS[8], KEYS[9])

      return { '${DRAINED}', current }
    `,
  });

  /**
   * Detach one exact block in constant work. RENAME transfers ownership of the complete edge hash,
   * including after a lost reply, without copying/encoding its fields. The separate manifest keeps an
   * empty withdrawal discoverable. Neither retained key expires; page acknowledgement owns reclamation.
   * KEYS: pend, done, edge, st, wd, targets, refs. ARGV: blockId.
   */
  redis.defineCommand("runAbandonRetainAndClear", {
    numberOfKeys: 11,
    lua: `
      local pend, done, edge, st, wd, targets, refs = unpack(KEYS)
      if ARGV[1] == '' then return redis.error_reply('runAbandonRetainAndClear: missing block id') end
      local current = redis.call('HGET', st, 'blk') or ''
      if redis.call('HGET', st, 'term') == '1' then return { '${TERMINAL}', current } end
      if current ~= ARGV[1] then return { '${STALE}', current } end
      local retained = redis.call('GET', wd)
      if retained and retained ~= ARGV[1] then
        return redis.error_reply('runAbandonRetainAndClear: invalid withdrawal identity')
      end
      local hasEdge = redis.call('EXISTS', edge) == 1
      if hasEdge and redis.call('EXISTS', targets) == 1 then
        return redis.error_reply('runAbandonRetainAndClear: active and retained targets conflict')
      end
      -- The manifest is the first durable write. If it cannot be recorded, nothing is detached.
      redis.call('SET', wd, ARGV[1])
      if redis.call('EXISTS', edge) == 1 then redis.call('RENAME', edge, targets) end
      redis.call('PERSIST', targets)
      redis.call('UNLINK', pend, done, refs, KEYS[8], KEYS[9], KEYS[10], KEYS[11])
      redis.call('HDEL', st, 'blk', 'hs')
      redis.call('HSET', st, 'rev', ARGV[2])
      return { '${RETAINED}' }
    `,
  });

  /** KEYS: pend, done, edge, st, wd, results, targets, refs. ARGV: blockId, nowMs, ttlMs. */
  redis.defineCommand("runTerminalRetainAndClear", {
    numberOfKeys: 12,
    lua: `
      local pend, done, edge, st, wd, results, targets, refs = unpack(KEYS)
      if ARGV[1] == '' then return redis.error_reply('runTerminalRetainAndClear: missing block id') end
      local ttl = tonumber(ARGV[3])
      if ttl == nil or ttl <= 0 then return redis.error_reply('runTerminalRetainAndClear: invalid TTL') end
      local current = redis.call('HGET', st, 'blk') or ''
      if redis.call('HGET', st, 'term') == '1' then return { '${TERMINAL}', current } end
      if current ~= '' and current ~= ARGV[1] then return { '${STALE}', current } end
      local retained = redis.call('GET', wd)
      if retained and retained ~= ARGV[1] then
        return redis.error_reply('runTerminalRetainAndClear: invalid withdrawal identity')
      end
      local hasEdge = redis.call('EXISTS', edge) == 1
      if current == ARGV[1] and hasEdge and redis.call('EXISTS', targets) == 1 then
        return redis.error_reply('runTerminalRetainAndClear: active and retained targets conflict')
      end
      local owesCleanup = current == ARGV[1] or retained or redis.call('HGET', st, 'co') == ARGV[1]
      if current == '' and not owesCleanup and redis.call('EXISTS', results) == 0 then
        return { '${ABSENT}' }
      end
      if current == ARGV[1] then
        -- Publish recovery evidence before detaching the active hash.
        redis.call('SET', wd, ARGV[1])
        if hasEdge then redis.call('RENAME', edge, targets) end
        redis.call('PERSIST', targets)
      end
      redis.call('UNLINK', pend, done, edge, refs, KEYS[9], KEYS[10], KEYS[11], KEYS[12])
      redis.call('HSET', st, 'term', '1', 'hs', '', 'termAt', ARGV[2], 'rev', ARGV[4])
      redis.call('HDEL', st, 'blk')
      redis.call('PEXPIRE', st, ttl)
      redis.call('PEXPIRE', results, ttl)
      if owesCleanup then return { '${RETAINED}' } end
      return { '${ABSENT}' }
    `,
  });

  /** Read without consuming; ack only after the cross-shard watcher withdrawals converge. */
  redis.defineCommand("runWithdrawalPage", {
    numberOfKeys: 2,
    lua: `
      local wd, targets = KEYS[1], KEYS[2]
      if ARGV[1] == '' then return redis.error_reply('runWithdrawalPage: missing block id') end
      local identity = redis.call('GET', wd)
      if not identity then return { '${ABSENT}' } end
      if identity ~= ARGV[1] then return redis.error_reply('runWithdrawalPage: invalid block identity') end
      if ARGV[2] == 'read' then
        local fields = redis.call('HRANDFIELD', targets, ${RUN_CLEANUP_PAGE_SIZE})
        local out = { '${RETAINED}' }
        for i = 1, #fields do out[#out + 1] = fields[i] end
        return out
      end
      if ARGV[2] ~= 'ack' or #ARGV - 2 > ${RUN_CLEANUP_PAGE_SIZE} then
        return redis.error_reply('runWithdrawalPage: invalid acknowledgement')
      end
      for i = 3, #ARGV do redis.call('HDEL', targets, ARGV[i]) end
      return { '${ACKNOWLEDGED}' }
    `,
  });

  /**
   * KEYS: st. ARGV: blockId.
   *
   * Durably mark this run's exact current store block as cleanup-owed, so `runAbsorbBlockers` refuses a
   * DIFFERENT block until the fence is cleared. Set BEFORE the retry/requeue transition. A terminal run
   * (already fenced by `term`) is a no-op — its own fence already refuses every absorb.
   */
  redis.defineCommand("runArmCleanupFence", {
    numberOfKeys: 1,
    lua: `
      local st = KEYS[1]
      if ARGV[1] == '' then
        return redis.error_reply('runArmCleanupFence: ARGV[1] must be the block id')
      end
      if redis.call('HGET', st, 'term') == '1' then
        return { '${TERMINAL}' }
      end
      redis.call('HSET', st, 'co', ARGV[1])
      return { '${ARMED}' }
    `,
  });

  /**
   * KEYS: st. ARGV: blockId.
   *
   * Remove the cleanup-owed fence, but ONLY when it names this exact block — so a stale clear can never
   * lift a newer block's owed fence. Called as the LAST step of a block's cleanup, after both its legacy
   * delete and its store retain-and-clear/withdrawal have converged.
   */
  redis.defineCommand("runClearCleanupFence", {
    numberOfKeys: 1,
    lua: `
      local st = KEYS[1]
      if ARGV[1] == '' then
        return redis.error_reply('runClearCleanupFence: ARGV[1] must be the block id')
      end
      if redis.call('HGET', st, 'co') == ARGV[1] then
        redis.call('HDEL', st, 'co')
        return { '${CLEARED}' }
      end
      return { '${ABSENT}' }
    `,
  });

  /**
   * KEYS: wd (the exact block's withdrawal manifest), st, targets. ARGV: blockId.
   *
   * ATOMICALLY retire a converged block's recovery evidence: delete its retained-withdrawal record AND
   * clear its cleanup-owed fence, in one same-slot step, so a process death can never leave the fence set
   * with no durable record to recover from (which would reject every later block forever). Both keys share
   * the run's `{runId}` hash slot. Idempotent: a missing record and/or an already-cleared or differently-
   * owned fence are all fine. The fence is cleared ONLY when it names THIS block — a newer block's `co` is
   * never touched. Refuses while any unacknowledged target remains.
   */
  redis.defineCommand("runFinalizeRetainedWithdrawal", {
    numberOfKeys: 3,
    lua: `
      local wd, st = KEYS[1], KEYS[2]
      if ARGV[1] == '' then
        return redis.error_reply('runFinalizeRetainedWithdrawal: ARGV[1] must be the block id')
      end
      local identity = redis.call('GET', wd)
      if identity and identity ~= ARGV[1] then
        return redis.error_reply('runFinalizeRetainedWithdrawal: invalid block identity')
      end
      if redis.call('HLEN', KEYS[3]) ~= 0 then
        return { '${RETAINED}' }
      end
      local cleanupOwed = redis.call('HGET', st, 'co')
      redis.call('UNLINK', wd, KEYS[3])
      if cleanupOwed == ARGV[1] then
        redis.call('HDEL', st, 'co')
        return { '${CLEARED}' }
      end
      return { '${ABSENT}' }
    `,
  });

  /**
   * Retire successful registration bookkeeping and its discovery entry in one same-slot commit.
   */
  redis.defineCommand("runDeleteContribution", {
    numberOfKeys: 2,
    lua: `
      redis.call('UNLINK', KEYS[1])
      redis.call('ZREM', KEYS[2], ARGV[1])
      return { '${CLEARED}' }
    `,
  });

  /**
   * Compensate at most one page, preserving unrelated edges and duplicate waitpoint references.
   * SPOP progress, edge removal and final index retirement commit together, including lost replies.
   * KEYS: pend, done, edge, st, contribution, refs, edgeIndex, doneOrder, early, earlyOrder, index.
   * ARGV: blockId, absorptionId, indexMember, revision.
   */
  redis.defineCommand("runCompensateAbsorption", {
    numberOfKeys: 11,
    lua: `
      local pend, done, edge, st, contrib, refs = unpack(KEYS)
      if ARGV[1] == '' or ARGV[2] == '' then
        return redis.error_reply('runCompensateAbsorption: missing identity')
      end
      local current = redis.call('HGET', st, 'blk') or ''
      if current ~= ARGV[1] or redis.call('HGET', st, 'term') == '1' then
        redis.call('UNLINK', contrib)
        redis.call('ZREM', KEYS[11], ARGV[3])
        return { '${STALE}', '0', '0', '0' }
      end
      -- Registered operations owe tail recovery, never compensation of accepted edges.
      if redis.call('SISMEMBER', contrib, '!registered') == 1 then
        return { '${RETAINED}', tostring(redis.call('HLEN', edge)), '0', '0' }
      end
      redis.call('HSET', st, 'rev', ARGV[4])
      redis.call('SREM', contrib, '!accepted')
      local removed = redis.call('SPOP', contrib, ${RUN_CLEANUP_PAGE_SIZE})
      local removedFields = 0
      for i = 1, #removed do
        local field = removed[i]
        if string.sub(field, 1, 1) ~= '!' then removedFields = removedFields + 1 end
        local releaseEdge = false
        if string.sub(field, 1, 1) ~= '!' and redis.call('HEXISTS', edge, field) == 1 then
          local claimField = '!' .. field
          local claims = tonumber(redis.call('HGET', refs, claimField)) or 1
          if claims > 1 then
            redis.call('HINCRBY', refs, claimField, -1)
          elseif claims ~= -1 then
            redis.call('HDEL', refs, claimField)
            releaseEdge = true
          end
        end
        if releaseEdge and redis.call('HDEL', edge, field) == 1 then
          redis.call('ZREM', KEYS[7], field)
          local sep = string.find(field, '#[^#]*$')
          if sep then
            local id = string.sub(field, 1, sep - 1)
            if redis.call('HINCRBY', refs, id, -1) <= 0 then
              redis.call('HDEL', refs, id)
              redis.call('HDEL', done, id)
              redis.call('ZREM', KEYS[8], id)
              redis.call('SREM', pend, id)
            end
          end
        end
      end
      local surviving = redis.call('HLEN', edge)
      local remaining = redis.call('SCARD', contrib)
      if remaining == 0 then redis.call('ZREM', KEYS[11], ARGV[3]) end
      local outcome = '${RETAINED}'
      if surviving == 0 and remaining == 0 then
        redis.call('UNLINK', pend, done, edge, refs, KEYS[7], KEYS[8], KEYS[9], KEYS[10])
        if redis.call('HGET', st, 'co') ~= ARGV[1] then
          redis.call('HDEL', st, 'blk', 'hs')
          outcome = '${CLEARED}'
        end
      end
      return { outcome, tostring(surviving), tostring(removedFields), tostring(remaining) }
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
      terminalTtlMs: string,
      completedByTaskRunId: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    wpRegisterOrReport(
      recordKey: string,
      watchersKey: string,
      queueKey: string,
      watcherField: string,
      watcherJson: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    wpComplete(
      recordKey: string,
      watchersKey: string,
      queueKey: string,
      fanoutKey: string,
      completionJson: string,
      completionId: string,
      nowMs: string,
      terminalTtlMs: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    wpFanoutClaim(
      recordKey: string,
      watchersKey: string,
      queueKey: string,
      fanoutKey: string,
      workerId: string,
      nowMs: string,
      leaseMs: string,
      pageSize: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    wpFanoutAck(
      recordKey: string,
      watchersKey: string,
      queueKey: string,
      fanoutKey: string,
      workerId: string,
      epoch: string,
      count: string,
      nowMs: string,
      terminalTtlMs: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    wpFanoutRelease(
      fanoutKey: string,
      workerId: string,
      epoch: string,
      nowMs: string,
      action: string,
      maxFailures: string,
      baseDelayMs: string,
      maxDelayMs: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    wpUnregisterWatcher(
      recordKey: string,
      watchersKey: string,
      watcherField: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    wpDescribe(
      recordKey: string,
      watchersKey: string,
      queueKey: string,
      fanoutKey: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    wpIdemReserve(
      key: string,
      waitpointId: string,
      expiresAtMs: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    wpDiscard(
      recordKey: string,
      watchersKey: string,
      queueKey: string,
      fanoutKey: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    wpFanoutIndex(
      dueKey: string,
      quarantineKey: string,
      op: string,
      waitpointId: string,
      scoreMs: string,
      limit: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    runAbsorbBlockers(
      pendKey: string,
      doneKey: string,
      edgeKey: string,
      stateKey: string,
      contributionKey: string,
      resultsKey: string,
      refsKey: string,
      edgeIndexKey: string,
      doneOrderKey: string,
      earlyKey: string,
      earlyOrderKey: string,
      predecessorWithdrawalKey: string,
      predecessorTargetsKey: string,
      contributionIndexKey: string,
      ...args: Array<string | Callback<string[]>>
    ): Result<string[], Context>;
    runDeliverCompletion(
      pendKey: string,
      doneKey: string,
      stateKey: string,
      resultsKey: string,
      refsKey: string,
      doneOrderKey: string,
      earlyKey: string,
      earlyOrderKey: string,
      blockId: string,
      waitpointId: string,
      completionJson: string,
      requireCurrentBlock: string,
      revision: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    runMarkHandoffAcked(
      stateKey: string,
      blockId: string,
      revision: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    runTerminalCleanup(
      pendKey: string,
      doneKey: string,
      edgeKey: string,
      stateKey: string,
      resultsKey: string,
      refsKey: string,
      edgeIndexKey: string,
      doneOrderKey: string,
      earlyKey: string,
      earlyOrderKey: string,
      nowMs: string,
      terminalTtlMs: string,
      voidHandoff: string,
      revision: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    runReadBlockState(
      edgeKey: string,
      stateKey: string,
      edgeIndexKey: string,
      doneOrderKey: string,
      earlyOrderKey: string,
      mode: string,
      revision: string,
      cutoff: string,
      edgeOffset: string,
      earlyAfter: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    runClear(
      pendKey: string,
      doneKey: string,
      edgeKey: string,
      stateKey: string,
      refsKey: string,
      edgeIndexKey: string,
      doneOrderKey: string,
      earlyKey: string,
      earlyOrderKey: string,
      ...args: Array<string | Callback<string[]>>
    ): Result<string[], Context>;
    runAbandonRetainAndClear(
      pendKey: string,
      doneKey: string,
      edgeKey: string,
      stateKey: string,
      withdrawalKey: string,
      targetsKey: string,
      refsKey: string,
      edgeIndexKey: string,
      doneOrderKey: string,
      earlyKey: string,
      earlyOrderKey: string,
      expectedBlockId: string,
      revision: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    runTerminalRetainAndClear(
      pendKey: string,
      doneKey: string,
      edgeKey: string,
      stateKey: string,
      withdrawalKey: string,
      resultsKey: string,
      targetsKey: string,
      refsKey: string,
      edgeIndexKey: string,
      doneOrderKey: string,
      earlyKey: string,
      earlyOrderKey: string,
      expectedBlockId: string,
      nowMs: string,
      terminalTtlMs: string,
      revision: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    runReadCleanupFence(stateKey: string, callback?: Callback<string[]>): Result<string[], Context>;
    runArmCleanupFence(
      stateKey: string,
      blockId: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    runClearCleanupFence(
      stateKey: string,
      blockId: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    runFinalizeRetainedWithdrawal(
      withdrawalKey: string,
      stateKey: string,
      targetsKey: string,
      blockId: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    runWithdrawalPage(
      withdrawalKey: string,
      targetsKey: string,
      ...args: Array<string | Callback<string[]>>
    ): Result<string[], Context>;
    runDeleteContribution(
      contributionKey: string,
      contributionIndexKey: string,
      member: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    runCompensateAbsorption(
      pendKey: string,
      doneKey: string,
      edgeKey: string,
      stateKey: string,
      contributionKey: string,
      refsKey: string,
      edgeIndexKey: string,
      doneOrderKey: string,
      earlyKey: string,
      earlyOrderKey: string,
      contributionIndexKey: string,
      blockId: string,
      absorptionId: string,
      member: string,
      revision: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
  }
}
