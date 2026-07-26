# Virtual-time (SFQ) scheduling for the concurrency-key dequeue

Implementation and testing plan for the recommendation out of three fairness
spikes. The spike harness and benchmark code are archived on the remote branch
`chore/fair-queueing-spike` (throwaway, never merged); the findings and research
they produced are kept alongside this plan as references:
`internal-packages/run-engine/design/references/run-queue-fairness-ck-findings.md`,
`.../run-queue-fairness-caps-vs-scheduling-findings.md`, and
`.../run-queue-fairness-research.md`.

The recommendation: score the per-base-queue concurrency-key selection by
start-time fair queueing (SFQ) virtual time instead of head timestamp, inside the
real batched CK-dequeue Lua, layered UNDER the existing per-key concurrency gate
and the planned group caps. Caps bound occupancy; the fair order bounds wait under
contention (the Kubernetes-APF shape, and the Parekh-Gallager joint result).

## Goal

When many concurrency-key variants of one base queue are contending, the
dequeue order across variants follows SFQ virtual time (each variant advances
its own virtual clock by a quantum per serve; new variants join at a monotonic
floor). This fixes the #2617 starvation dynamic the spikes measured: a key
arriving behind a big backlog waits its fair turn instead of waiting for the
backlog to drain, and (unlike per-key caps) the fix survives a tenant sharding
its work across many keys, while staying work-conserving.

Everything is behind a constructor feature flag. Flag off is byte-identical to
today: the exact same Lua scripts run and no new Redis keys are ever touched.

## Architecture

The design keeps `ckIndex` exactly as it is and adds a parallel virtual-time
ZSET. This is the load-bearing decision, so the reasoning up front:

`ckIndex` scores are head-message timestamps, and three things depend on that
score domain staying timestamps:

1. Time eligibility. `ZRANGEBYSCORE ckIndexKey -inf now` filters out variants
   whose head message is scheduled in the future (delayed runs, nack backoff).
   Virtual-time tags carry no wall-clock meaning, so they cannot express "not
   available yet".
2. Master-queue rebalancing. Every CK Lua (enqueue, dequeue, ack, nack, the
   sweeper) re-scores the `:ck:*` master-queue member from `ZRANGE ckIndexKey
   0 0 WITHSCORES`. The master queue is timestamp-ordered and compared against
   `now`; writing virtual times there would corrupt the shard-level selection.
3. Every other writer. `enqueueMessageCkTracked`, `nackMessageCkTracked`,
   `acknowledgeMessageCkTracked`, the concurrency sweeper (index.ts ~3733,
   ~3847) all `ZADD ckIndexKey <head timestamp>`. Rescoring only in the dequeue
   Lua would leave a mixed score domain, and during a rolling deploy old
   instances would keep writing timestamps regardless (the mixed-arity hazard
   the caps plan warned about, in score-domain form).

So: instead of changing `ckIndex`'s score domain, add per base queue

- `{org:...}:...:queue:<base>:ckVtime`, a ZSET, member = the full CK-variant
  queue name (the same member strings `ckIndex` holds), score = the variant's
  next virtual start tag (the spike's `SfqCk.clock` value, i.e. start of last
  serve + quantum).
- `{org:...}:...:queue:<base>:ckVtimeFloor`, a STRING holding the monotonic
  floor (the CFS `min_vruntime` analogue from `disciplines.ts`).

Both live under the same `{org:...}` hash tag as every other key of the base
queue, so cluster slotting is unchanged and one Lua script can touch all of
them atomically.

The dequeue Lua (new command, flag-selected) runs two passes:

- Pass 1 (fair order): take candidates from `ckVtime` by rank (lowest tag
  first, `ZRANGE 0 W-1 WITHSCORES`), and for each run the existing
  per-candidate logic unchanged: per-key concurrency gate, per-variant
  time-eligibility check (`ZRANGEBYSCORE <variant> -inf now LIMIT 0 1`), TTL
  branch, counters, `ckIndex` rebalance. On each successful serve, advance
  that variant's tag (`ZADD ckVtimeKey max(tag, floor) + quantum/weight`)
  before moving to the next candidate, so the state is correct per serve
  within the batch. A skipped variant (at cap, or head in the future) keeps
  its tag: no service, no advance, which is the SFQ rule.
- Pass 2 (fill + discovery): if pass 1 served fewer than `actualMaxCount`,
  scan `ckIndex` in today's age order (`ZRANGEBYSCORE -inf now LIMIT 0 W`),
  skip variants already attempted in pass 1, and serve the rest through the
  same per-candidate logic, registering each served variant into `ckVtime`.
  Pass 2 makes the new command a strict superset of today's: it can never
  serve fewer messages than the current script would, so work conservation
  and mixed-deploy discovery both hold by construction.

Registration (how a variant gets INTO `ckVtime` before it is ever served):
every Lua that adds messages to a variant, i.e. the CK enqueue commands and
the CK nack command, gains a flag-selected variant that does
`ZADD ckVtimeKey NX <floor> <variant>` after its existing `ckIndex` rebalance.
`NX` means registration can never rewind an advanced tag. This is what makes
the sybil case work: a brand-new light key is present in the vtime order at
the floor from its first enqueue, so it is reachable in pass 1 even when a
hundred attacker variants have older heads (which is exactly where today's
age-ordered `*3` window fails, per CAPS_FINDINGS).

Closure argument for registration (state this as an invariant and test it):
a variant's queue becomes non-empty only via enqueue or nack, both of which
register. The sweeper and ack/release Luas only rebalance variants whose
queues are already non-empty, so they never need to register. The dequeue Lua
GCs a variant from BOTH `ckIndex` and `ckVtime` when its queue is empty, so
membership stays closed under all transitions. The one gap is old-code
enqueues during a rolling deploy, and pass 2 covers that (served via age
order, registered on serve).

Batched-call semantics: the current Lua serves at most ONE message per variant
per call (`LIMIT 0, 1` per candidate, and ZSET members are unique in the
candidate list). The new command keeps that. Within one call the batch is
therefore one-serve-per-variant round robin over the `actualMaxCount` lowest
tags, and each serve's `ZADD` makes the NEXT call's order correct. This
deviates from pure SFQ within a single batch (pure SFQ could serve the same
far-behind variant several times in a row) but converges across calls, and
one-per-variant is itself a fair schedule. Preserving it also means zero
change to today's per-call throughput shape.

Layering with caps: the per-key gate (`ckCurrentConcurrency <
queueConcurrencyLimit`) stays exactly where it is, ahead of the serve. The
planned Phase-1 `:groupConcurrency`/`:totalConcurrency` total cap and Phase-2
`:ckLimits` per-key overrides slot into the same per-candidate position as
additional admission conditions when they land; virtual time only decides the
ORDER among candidates those gates admit. Nothing in this plan blocks or is
blocked by the caps work, and the fairQueue-level "queue at total" drop stays
untouched (the CK pick is below the `RunQueueSelectionStrategy` interface;
`fairQueueSelectionStrategy.ts` is not modified).

Weights: concurrency keys carry no configured weight today, so every key gets
weight 1 (quantum advance of 1.0 per serve). The advance is written as
`quantum / weight` with `weight` a named local fixed at 1, so a future
per-key weight (e.g. a sparse `:ckWeights` HASH mirroring the Phase-2
`:ckLimits` shape) is a one-line change at the marked site. Justification for
equal-weight first: the spikes only measured equal weights, no product surface
exists to set a weight, and SFQ's starvation fix does not depend on weights.

State lifecycle (GC/TTL), since concurrency keys are client-chosen and
unbounded:

- Per-variant GC: whenever the dequeue Lua finds a variant queue empty it
  already `ZREM`s the variant from `ckIndex`; the new command also `ZREM`s it
  from `ckVtime` at those sites. A GC'd key that returns re-registers at the
  floor, which is standard SFQ flow re-entry (history is forgiven when a flow
  drains; a drained flow was by definition not backlogged).
- Whole-key TTL: `ckVtime` and `ckVtimeFloor` get `EXPIRE <stateTtlSeconds>`
  (default 86400, matching the `counterTtlSeconds` precedent) refreshed on
  every write. An idle base queue's vtime state evaporates; on resumption
  everyone re-enters at floor 0, which is a clean restart. If only the floor
  key expires, tags in `ckVtime` still self-heal because every read applies
  `max(tag, floor)` and the next dequeue re-advances the floor to the minimum
  stored tag.
- Cardinality guard: tags are only created for variants that actually have
  queued messages (registration happens on enqueue/nack, GC on empty), so
  `ckVtime` cardinality is bounded by `ckIndex` cardinality plus transiently
  stale entries awaiting scan-time GC or TTL expiry.

Floor semantics: on each dequeue call, `floor = max(stored floor, score of
ckVtime rank 0)`, written back with the TTL. The floor never decreases (test
this), and a newly registered key's tag starts AT the floor, so it can never
be scheduled behind the accumulated backlog of long-running keys (the SFQ
property; this is the exact `SfqCk` logic from `disciplines.ts`, moved into
Lua with the Map replaced by the ZSET and the floor by the STRING).

Numeric domain: tags are Redis doubles starting at 0 advancing by 1.0 per
serve; integer-exact to 2^53 serves per base queue, so precision is a
non-issue.

The scan window: pass 1's window is `actualMaxCount * windowMultiplier`
(default multiplier 3, same as today, made configurable). The score domain of
the window changes meaning: today the window can hide the oldest ELIGIBLE
head behind at-cap variants with older heads; under vtime it can hide the
lowest ELIGIBLE tag behind at-cap or future-scheduled variants with lower
tags. Those clogging variants keep low tags while skipped (no serve, no
advance), so the failure shape is symmetric with today's, and it is the same
class of limitation CAPS_FINDINGS documents for the `*3` window rather than a
new one. We do not widen the default; we make the multiplier an option so an
operator can widen it if per-key caps plus heavy nack backoff ever clog a
window in practice, and pass 2 guarantees the call still finds work.

## Tech stack

- Redis Lua (ioredis `defineCommand`) in
  `internal-packages/run-engine/src/run-queue/index.ts`, following the
  existing tracked-command patterns.
- TypeScript for options plumbing and call-site selection.
- vitest + `@internal/testcontainers` (`redisTest`) for all tests. No mocks.
- Verification: `pnpm run typecheck --filter @internal/run-engine` and
  `cd internal-packages/run-engine && pnpm run test <file> --run`.

## Global constraints

- Flag off must be byte-identical: off-path call sites keep calling the
  existing command names whose script text is not edited at all. New
  behaviour lives only in NEW command names (`...Vtime...`), selected in TS.
  This is why we add command variants instead of threading an `enableVtime`
  ARGV through existing scripts: an ARGV-gated single script would still be a
  new script body (new SHA, new arity risks) even when the flag is off.
- `ckIndex`, the master queue, `fairQueueSelectionStrategy.ts`, and all
  ack/release/sweeper Luas keep their current score domain and text.
- The dead untracked `dequeueMessagesFromCkQueue` (index.ts ~3999-4141) is not
  touched and gets no vtime variant.
- All vtime state mutations happen inside single Lua scripts (atomic; Redis
  serialises scripts, which is the whole multi-consumer correctness story).
- No process-memory scheduling state anywhere.
- Do not import anything from `fairness-spike-ck/` or `fairness-spike/` into
  production code or the new tests; those directories are throwaway (their
  own headers say delete before merge). Port logic and scenario shapes by
  copying, with attribution comments.
- Zod stays at the repo-pinned version; no new dependencies.
- Formatting/lint before commit: `pnpm run format && pnpm run lint:fix`.

## File structure

Modify:

- `internal-packages/run-engine/src/run-queue/keyProducer.ts`
  (two new key builders + constants)
- `internal-packages/run-engine/src/run-queue/types.ts`
  (`RunQueueKeyProducer` interface additions)
- `internal-packages/run-engine/src/run-queue/index.ts`
  (options field; four new `defineCommand`s; TS module augmentation for them;
  flag switches at the enqueue/nack/dequeue call sites; span attributes)
- `internal-packages/run-engine/src/run-queue/tests/keyProducer.test.ts`
  (key builder tests)
- `internal-packages/run-engine/src/engine/types.ts`
  (`RunEngineOptions["queue"].ckVirtualTimeScheduling`)
- `internal-packages/run-engine/src/engine/index.ts`
  (pass the option through to `new RunQueue({...})`, ~line 196)
- `apps/webapp/app/env.server.ts`
  (`RUN_ENGINE_CK_VTIME_SCHEDULING_ENABLED` and friends)
- `apps/webapp/app/v3/runEngine.server.ts`
  (wire env vars into the engine options, ~line 61 `queue:` block)

Create:

- `internal-packages/run-engine/src/run-queue/tests/ckVtime.test.ts`
  (Lua behaviour: ordering, floor, tag init, advance-within-batch, GC, TTL,
  registration, pass-2 fill, flag-off keyspace purity)
- `internal-packages/run-engine/src/run-queue/tests/ckVtimeFairness.test.ts`
  (ported scenarios at batched maxCount, wait/share/work-conservation/sybil
  assertions)
- `internal-packages/run-engine/src/run-queue/tests/ckVtimeConcurrency.test.ts`
  (multi-consumer correctness, op-count budget)
- `.server-changes/2026-07-24-ck-fair-scheduling.md` (at PR time; note it
  ships dark)

## Tasks

### Task 1: key producer additions

Files: `keyProducer.ts`, `types.ts`, `tests/keyProducer.test.ts`.

Test first (append to `tests/keyProducer.test.ts`, matching its existing
style):

```ts
it("produces ckVtime keys from a CK variant queue name", () => {
  const keys = new RunQueueFullKeyProducer();
  const q = "{org:o1}:proj:p1:env:e1:queue:task/my-task:ck:tenant-a";
  expect(keys.ckVtimeKeyFromQueue(q)).toBe(
    "{org:o1}:proj:p1:env:e1:queue:task/my-task:ckVtime"
  );
  expect(keys.ckVtimeFloorKeyFromQueue(q)).toBe(
    "{org:o1}:proj:p1:env:e1:queue:task/my-task:ckVtimeFloor"
  );
  // ck wildcard and base-queue inputs normalise the same way
  expect(keys.ckVtimeKeyFromQueue(q.replace(":ck:tenant-a", ":ck:*"))).toBe(
    keys.ckVtimeKeyFromQueue(q)
  );
});
```

Implementation in `keyProducer.ts`: add to `constants`

```ts
CK_VTIME_PART: "ckVtime",
CK_VTIME_FLOOR_PART: "ckVtimeFloor",
```

and the builders (next to `ckIndexKeyFromQueue`):

```ts
ckVtimeKeyFromQueue(queue: string): string {
  return `${this.baseQueueKeyFromQueue(queue)}:${constants.CK_VTIME_PART}`;
}

ckVtimeFloorKeyFromQueue(queue: string): string {
  return `${this.baseQueueKeyFromQueue(queue)}:${constants.CK_VTIME_FLOOR_PART}`;
}
```

Add both signatures to `RunQueueKeyProducer` in `types.ts`.

Verify: `cd internal-packages/run-engine && pnpm run test ./src/run-queue/tests/keyProducer.test.ts --run`
(new tests pass, existing pass), then
`pnpm run typecheck --filter @internal/run-engine` (clean).

### Task 2: options plumbing in RunQueue

File: `index.ts` (RunQueueOptions, ~line 60).

```ts
/**
 * Fair (virtual-time / SFQ) ordering across concurrency-key variants of a
 * base queue. Off by default; when off, the exact pre-existing Lua commands
 * run and no vtime keys are created. See internal-packages/run-engine/design/plans/
 * 2026-07-23-ck-virtual-time-scheduling-plan.md.
 */
ckVirtualTimeScheduling?: {
  enabled: boolean;
  /** Virtual-time advance per serve (dimensionless). Default 1. */
  quantum?: number;
  /** Pass-1 candidate window = actualMaxCount * this. Default 3. */
  scanWindowMultiplier?: number;
  /** EXPIRE applied to ckVtime/ckVtimeFloor on every write. Default 86400. */
  stateTtlSeconds?: number;
};
```

Store resolved values once in the constructor (private readonly fields
`#ckVtimeEnabled`, `#ckVtimeQuantum`, `#ckVtimeWindowMultiplier`,
`#ckVtimeStateTtl`) so call sites read fields, never re-derive.

Verify: `pnpm run typecheck --filter @internal/run-engine`.

### Task 3: the vtime dequeue Lua (the core change)

File: `index.ts`. New command `dequeueMessagesFromCkQueueVtimeTracked`,
`numberOfKeys: 12` (the 10 keys of `dequeueMessagesFromCkQueueTracked` plus
`ckVtimeKey`, `ckVtimeFloorKey`), plus its entry in the ioredis module
augmentation (next to the existing declaration at ~line 5591, same parameter
list plus `ckVtimeKey: string, ckVtimeFloorKey: string` after
`lengthCounterKey` and `quantum: string, windowMultiplier: string,
stateTtlSeconds: string` after `maxCount`).

Write the failing tests FIRST in `tests/ckVtime.test.ts`. Scaffold the file
from `tests/ckIndex.test.ts` (same `testOptions`, `authenticatedEnvDev`,
`createQueue`, `makeMessage` helpers), with `createQueue` extended to accept
`ckVirtualTimeScheduling` overrides. Tests to write in this task:

1. "vtime order beats head-timestamp order": enqueue 30 messages on
   `ck: heavy` with timestamps `t0 .. t0+29`, then 3 messages on `ck: light`
   at `t0+1000`. Register both (enqueue registration is Task 4; until then
   the test seeds `ckVtime` directly with
   `queue.redis.zadd(ckVtimeKey, 0, heavyVariant, 0, lightVariant)`).
   Dequeue with `maxCount: 10` repeatedly (acking between calls to free
   concurrency). Assert light's 3 messages are all served within the first 3
   calls (age order alone would drain heavy first). Assert each call returns
   at most one message per variant.
2. "tags advance per serve within one batched call": seed 5 variants at tag
   0, one message each; one dequeue call with `maxCount: 5`; assert all 5
   served and `ZSCORE ckVtime <v>` is `1` for each (advanced inside the one
   call, not once per call).
3. "floor is monotonic and read-repairs": drive tags to ~20 by repeated
   serve of two keys, assert `GET ckVtimeFloor` never decreased across calls
   (sample after each call), and equals the min stored tag after the last.
4. "new key initialises at the floor, not zero and not behind the backlog":
   after tags reach ~20, register a fresh variant with the enqueue path (or
   direct ZADD NX at the current floor pre-Task-4), enqueue one message on
   it, one dequeue call; assert the fresh variant is served in that first
   call and its tag afterwards is `floor + quantum`, not `1`.
5. "no service, no advance": set the base queue concurrency limit to 1 via
   `queue.updateQueueConcurrencyLimits`, occupy `ck: a`'s slot (dequeue one,
   do not ack), then call dequeue; assert `ck: a` was skipped, its tag is
   unchanged, and other variants were served.
6. "GC on empty variant": drain a variant completely; assert it is removed
   from BOTH `ckIndex` and `ckVtime`.
7. "TTL is set and refreshed": after any dequeue, `PTTL ckVtime` and
   `PTTL ckVtimeFloor` are in `(0, stateTtlSeconds * 1000]`.
8. "pass 2 fill serves unregistered variants and registers them": enqueue on
   a variant, delete its `ckVtime` entry by hand (simulating an old-code
   enqueue), dequeue; assert the message is served AND the variant now has a
   `ckVtime` tag.
9. "future-scheduled variants are skipped without advance": nack a message
   with a future score (or enqueue with future timestamp); dequeue; assert
   the variant is not served and its tag is unchanged.

The Lua. Full sketch (the per-candidate serve body is today's tracked body
verbatim; only the parts marked NEW differ):

```lua
local ckIndexKey = KEYS[1]
local queueConcurrencyLimitKey = KEYS[2]
local envConcurrencyLimitKey = KEYS[3]
local envConcurrencyLimitBurstFactorKey = KEYS[4]
local envCurrentConcurrencyKey = KEYS[5]
local messageKeyPrefix = KEYS[6]
local envQueueKey = KEYS[7]
local masterQueueKey = KEYS[8]
local ttlQueueKey = KEYS[9]
local lengthCounterKey = KEYS[10]
local ckVtimeKey = KEYS[11]        -- NEW
local ckVtimeFloorKey = KEYS[12]   -- NEW

local ckWildcardName = ARGV[1]
local currentTime = tonumber(ARGV[2])
local defaultEnvConcurrencyLimit = ARGV[3]
local defaultEnvConcurrencyBurstFactor = ARGV[4]
local keyPrefix = ARGV[5]
local maxCount = tonumber(ARGV[6] or '1')
local quantum = tonumber(ARGV[7] or '1')            -- NEW
local windowMultiplier = tonumber(ARGV[8] or '3')   -- NEW
local stateTtl = tonumber(ARGV[9] or '86400')       -- NEW

local function decrLengthCounter()
  if tonumber(redis.call('GET', lengthCounterKey) or '0') > 0 then
    redis.call('DECR', lengthCounterKey)
  end
end

-- env gate: identical to dequeueMessagesFromCkQueueTracked
local envCurrentConcurrency = tonumber(redis.call('SCARD', envCurrentConcurrencyKey) or '0')
local envConcurrencyLimit = tonumber(redis.call('GET', envConcurrencyLimitKey) or defaultEnvConcurrencyLimit)
local envConcurrencyLimitBurstFactor = tonumber(redis.call('GET', envConcurrencyLimitBurstFactorKey) or defaultEnvConcurrencyBurstFactor)
local envConcurrencyLimitWithBurstFactor = math.floor(envConcurrencyLimit * envConcurrencyLimitBurstFactor)
if envCurrentConcurrency >= envConcurrencyLimitWithBurstFactor then
  return nil
end
local queueConcurrencyLimit = math.min(tonumber(redis.call('GET', queueConcurrencyLimitKey) or '1000000'), envConcurrencyLimit)
local envAvailableCapacity = envConcurrencyLimitWithBurstFactor - envCurrentConcurrency
local actualMaxCount = math.min(maxCount, envAvailableCapacity)
if actualMaxCount <= 0 then
  return nil
end

local window = actualMaxCount * windowMultiplier

-- NEW: monotonic floor, advanced to the minimum stored tag
local floor = tonumber(redis.call('GET', ckVtimeFloorKey) or '0')
local minEntry = redis.call('ZRANGE', ckVtimeKey, 0, 0, 'WITHSCORES')
if #minEntry > 0 then
  local minTag = tonumber(minEntry[2])
  if minTag > floor then
    floor = minTag
  end
end

local results = {}
local dequeuedCount = 0
local attempted = {}

-- Per-candidate serve. Body between BEGIN/END COPY is today's tracked
-- per-candidate block, unmodified except the two NEW lines.
local function tryServe(ckQueueName)
  attempted[ckQueueName] = true
  local fullQueueKey = keyPrefix .. ckQueueName
  local ckConcurrencyKey = fullQueueKey .. ':currentConcurrency'
  local ckCurrentConcurrency = tonumber(redis.call('SCARD', ckConcurrencyKey) or '0')
  if ckCurrentConcurrency >= queueConcurrencyLimit then
    return
  end
  -- BEGIN COPY (from dequeueMessagesFromCkQueueTracked, lines ~4219-4273)
  local messages = redis.call('ZRANGEBYSCORE', fullQueueKey, '-inf', tostring(currentTime), 'WITHSCORES', 'LIMIT', 0, 1)
  if #messages >= 2 then
    -- ... TTL-expired / normal-dequeue / stale-orphan branches verbatim ...
    -- in the normal-dequeue branch, after dequeuedCount = dequeuedCount + 1:
    --   NEW: advance this variant's virtual time (weight hook: fixed 1 today)
    --   local weight = 1
    --   local tag = tonumber(redis.call('ZSCORE', ckVtimeKey, ckQueueName) or floor)
    --   if tag < floor then tag = floor end
    --   redis.call('ZADD', ckVtimeKey, tag + (quantum / weight), ckQueueName)
    -- rebalance ckIndex from the variant head, verbatim, plus:
    --   NEW: if the variant queue is empty, also redis.call('ZREM', ckVtimeKey, ckQueueName)
  else
    -- empty-in-range branch verbatim, plus the same NEW ZREM when fully empty
  end
  -- END COPY
end

-- Pass 1: fair order (lowest virtual start tag first)
local vtimeCandidates = redis.call('ZRANGE', ckVtimeKey, 0, window - 1)
for _, ckQueueName in ipairs(vtimeCandidates) do
  if dequeuedCount >= actualMaxCount then break end
  tryServe(ckQueueName)
end

-- Pass 2: fill + discovery in today's age order (work conservation,
-- mixed-deploy safety). Never runs when pass 1 filled the batch.
if dequeuedCount < actualMaxCount then
  local ckQueues = redis.call('ZRANGEBYSCORE', ckIndexKey, '-inf', tostring(currentTime), 'LIMIT', 0, window)
  for _, ckQueueName in ipairs(ckQueues) do
    if dequeuedCount >= actualMaxCount then break end
    if not attempted[ckQueueName] then
      tryServe(ckQueueName)
    end
  end
end

-- NEW: persist floor and refresh TTLs
redis.call('SET', ckVtimeFloorKey, tostring(floor), 'EX', stateTtl)
if redis.call('EXISTS', ckVtimeKey) == 1 then
  redis.call('EXPIRE', ckVtimeKey, stateTtl)
end

-- master queue rebalance: verbatim from the tracked command (uses ckIndex,
-- which keeps its timestamp domain)
local earliestIdx = redis.call('ZRANGE', ckIndexKey, 0, 0, 'WITHSCORES')
if #earliestIdx == 0 then
  redis.call('ZREM', masterQueueKey, ckWildcardName)
else
  redis.call('ZADD', masterQueueKey, earliestIdx[2], ckWildcardName)
end

return results
```

Note the `tryServe` extraction is inside the NEW script only; the old script
is not refactored. When writing the real script, inline today's per-candidate
block into `tryServe` exactly (including `decrLengthCounter`, the TTL-member
removal, and both rebalance branches); the sketch elides it to keep the plan
readable, and the byte-identity constraint applies to the OLD script, which
is untouched.

Call-site switch in `#callDequeueMessagesFromCkQueue` (~line 2206):

```ts
const result = this.#ckVtimeEnabled
  ? await this.redis.dequeueMessagesFromCkQueueVtimeTracked(
      ckIndexKey, queueConcurrencyLimitKey, envConcurrencyLimitKey,
      envConcurrencyLimitBurstFactorKey, envCurrentConcurrencyKey,
      messageKeyPrefix, envQueueKey, masterQueueKey, ttlQueueKey,
      lengthCounterKey,
      this.keys.ckVtimeKeyFromQueue(ckWildcardQueue),
      this.keys.ckVtimeFloorKeyFromQueue(ckWildcardQueue),
      ckWildcardQueue, String(Date.now()),
      String(this.options.defaultEnvConcurrency),
      String(this.options.defaultEnvConcurrencyBurstFactor ?? 1),
      this.options.redis.keyPrefix ?? "", String(maxCount),
      String(this.#ckVtimeQuantum), String(this.#ckVtimeWindowMultiplier),
      String(this.#ckVtimeStateTtl)
    )
  : await this.redis.dequeueMessagesFromCkQueueTracked(/* unchanged */);
```

Add span attributes on the vtime path: `ck_vtime_enabled: true` plus, from a
small extension of the return shape if desired later, keep it simple now and
only tag the flag.

Verify: `cd internal-packages/run-engine && pnpm run test ./src/run-queue/tests/ckVtime.test.ts --run`
(tests 1-3, 5-9 pass; 4 passes with the direct-ZADD seeding until Task 4),
then `pnpm run typecheck --filter @internal/run-engine`.

### Task 4: enqueue registration

File: `index.ts`. Two new commands, `enqueueMessageCkVtimeTracked` and
`enqueueMessageWithTtlCkVtimeTracked`, `numberOfKeys: 17` (the existing 15
plus `ckVtimeKey` as KEYS[16] and `ckVtimeFloorKey` as KEYS[17]; the WithTtl
variant is existing-16 plus 2), ARGV extended with `stateTtl`. Script body =
existing tracked script verbatim, plus, in the SLOW PATH ONLY, immediately
after the `-- Rebalance CK index` block:

```lua
-- Register this variant in the virtual-time index at the floor. NX means an
-- already-advanced tag is never rewound.
local vfloor = redis.call('GET', ckVtimeFloorKey) or '0'
redis.call('ZADD', ckVtimeKey, 'NX', vfloor, queueName)
redis.call('EXPIRE', ckVtimeKey, stateTtl)
```

The fast path (direct-to-worker-queue when the variant is empty and capacity
is free) does NOT register or advance; see open decision 1.

Tests first, in `tests/ckVtime.test.ts`:

10. "enqueue registers the variant at the current floor with NX": drive the
    floor to ~5 via serves, enqueue on a fresh key, assert
    `ZSCORE ckVtime <fresh>` equals the floor; enqueue a second message on a
    key whose tag is 9, assert the tag is still 9.
11. "test 4 now passes end-to-end without direct ZADD seeding" (remove the
    seeding from test 4).
12. "fast path leaves vtime state untouched": empty variant, free capacity,
    enqueue (fast path fires, returns 1); assert no `ckVtime` entry was
    created for it. Then saturate capacity, enqueue again (slow path);
    assert registration happened.

Call-site switches at ~lines 1906 and 1941 pick the vtime variants when
`this.#ckVtimeEnabled`, passing the two extra keys and `stateTtl`. Add both
to the module augmentation.

Verify: same test file command; plus
`pnpm run test ./src/run-queue/tests/enqueueMessage.test.ts --run` and
`./src/run-queue/tests/ckIndex.test.ts --run` still green (flag off).

### Task 5: nack registration

File: `index.ts`. New command `nackMessageCkVtimeTracked`,
`numberOfKeys: 13` (existing 11 plus the two vtime keys), ARGV plus
`stateTtl`. Body = existing verbatim plus the same NX-register block after
its `-- Rebalance CK index` section. Call-site switch at ~line 2584.

Test first (in `tests/ckVtime.test.ts`):

13. "nack re-registers a GC'd variant": enqueue one message on `ck: a`,
    dequeue it (variant now GC'd from both indexes), nack it; assert the
    variant is back in `ckIndex` AND in `ckVtime` at the floor, and a
    subsequent dequeue serves it (respecting its future score if the nack
    applied backoff: use a nack with an immediate retry score).

Closure invariant test:

14. "ckVtime membership tracks ckIndex membership": property-style loop of
    ~200 random operations (enqueue on 1 of 8 keys, dequeue batch, ack or
    nack a random in-flight message); after each step assert every member of
    `ckIndex` is a member of `ckVtime` (the converse may transiently not
    hold, which is fine; stale `ckVtime` entries GC on scan).

Verify: `pnpm run test ./src/run-queue/tests/ckVtime.test.ts --run` and
`./src/run-queue/tests/nack.test.ts --run` (flag off, untouched).

### Task 6: fairness scenarios on the real batched path

File: `tests/ckVtimeFairness.test.ts` (new). This closes the spike's fidelity
gap: the spike proved the ordering at `maxCount = 1` with driver-side
rescoring; these tests drive the REAL batched Lua (`maxCount = 10`) with the
state advanced inside the script.

Harness design (deterministic, no wall-clock sleeps, no spike imports): a
step loop against one `RunQueue` on testcontainers Redis.

- Enqueue with explicit `timestamp` values in `InputPayload` (all in the
  past so everything is time-eligible; the backlog key gets one old shared
  timestamp, other keys get strictly increasing later timestamps, mirroring
  the ckScenarios head-age reasoning).
- Each step: call the dequeue path once with `maxCount: 10` (via the public
  dequeue API used by `ckIndex.test.ts`), record `(step, variant, messageId)`
  per served message, then ack each served message after a per-key logical
  hold of H steps (keep a small in-flight list and ack entries whose
  `servedAt + H <= step`), which is how the env concurrency contends.
- Wait metric per message = serve step minus a per-message logical arrival
  step (arrival step derived from the enqueue order). All assertions are on
  ratios between flag-on and flag-off runs of the SAME scenario and seed, so
  they are stable in CI; use generous factors.

Scenarios (ported shapes from `ckScenarios.ts` and
`capsFairness.bench.test.ts`, scaled down for CI):

- ckSkew: heavy 120 backlog msgs (old shared head), 4 light keys x 10 msgs
  (later heads). env limit 4, hold 3 steps. Assert: mean light-key wait with
  flag ON <= 0.3 x flag OFF (spike measured ~1100 -> ~15, so 0.3 is very
  loose); heavy key's wait may rise (do not assert it down).
- ckTrickle: bulk 120, two trickle keys x 15. Same assertion.
- ckSybil (the case caps cannot fix): 20 attacker keys x 8 msgs each, all
  older heads, 1 light key x 10 newer. Assert: flag ON mean light wait
  <= 0.7 x flag OFF (spike: 1765 -> 1009), AND light key's first serve
  happens within the first 3 steps (reachability at the floor), AND
  contention-window share: over the steps where >= 2 keys have queued
  backlog, light's served fraction >= 0.5 x its fair share 1/21 (directional,
  per the spike's confounding caveat; wait is the headline).
- ckBalanced (no-harm check): 4 symmetric keys x 25. Assert: max per-key
  mean wait with flag ON <= 1.25 x flag OFF (fair order must not make the
  symmetric case worse).
- ckHeavyIdle (work conservation): single key, 60 msgs. Assert: steps to
  drain with flag ON == flag OFF exactly (nothing else contends, so any
  extra step is a work-conservation bug).

Also assert in every scenario: total served ON == total served OFF == total
enqueued (no loss, no double-serve; `messageId`s unique).

Verify: `cd internal-packages/run-engine && pnpm run test ./src/run-queue/tests/ckVtimeFairness.test.ts --run`
(all scenarios pass; target < 60s wall time total, scale message counts down
if needed before loosening assertions).

### Task 7: multi-consumer / multi-shard correctness

File: `tests/ckVtimeConcurrency.test.ts` (new).

15. "two consumers, one base queue, no corruption": one `RunQueue` for
    enqueues, two more instances (same Redis, same key prefix, flag on) each
    running a dequeue loop with `maxCount: 5` concurrently
    (`Promise.all` of two loops, acking with a short hold). 6 keys x 30
    messages. Assert: every message served exactly once across both
    consumers (union of served IDs has no duplicates and equals the enqueued
    set); after drain, `ckVtime` is empty and floor equals the max it ever
    reached; sample the floor between iterations and assert it never
    decreased. The correctness argument is that every mutation happens
    inside one Lua script and Redis serialises scripts; this test is the
    check that the scripts do not assume cross-call state.
16. "concurrent enqueue during dequeue cannot rewind a tag": interleave
    enqueues on a hot key with dequeue batches; after each round assert
    `ZSCORE ckVtime <hot>` is non-decreasing (NX registration + advance-only
    writes).

17. "op-count budget": using a second plain Redis client, `CONFIG RESETSTAT`,
    run 50 identical dequeue calls flag OFF, snapshot
    `INFO commandstats` total calls; repeat flag ON with identical data.
    Assert `on_total <= off_total + 50 * (6 + 2 * maxCount)` (per call the
    vtime path adds at worst: GET floor, ZRANGE min, ZRANGE window, SET
    floor, EXPIRE, the pass-2 ZRANGEBYSCORE, plus per serve one ZSCORE and
    one ZADD). This pins the per-dequeue overhead the way the caps plan pins
    the fairQueue snapshot cost.

Verify: `cd internal-packages/run-engine && pnpm run test ./src/run-queue/tests/ckVtimeConcurrency.test.ts --run`.

### Task 8: default-off regression proof

Location: `tests/ckVtime.test.ts` (final describe block).

18. "flag off creates no vtime keys and matches today's order": with
    `ckVirtualTimeScheduling` absent, run a mixed sequence (enqueues across
    3 keys with distinct head ages, batched dequeues, one nack, acks), then:
    `KEYS *` contains no key matching `*ckVtime*`; the dequeue order equals
    the head-timestamp order (re-assert the core expectation of
    `ckIndex.test.ts` inside this sequence). The stronger guarantee (same
    script text, same SHA) holds by construction: the off path calls the
    same command names whose `defineCommand` strings this plan never edits;
    say so in a comment rather than pretending a test can diff against an
    old build.
19. Run the whole existing run-queue suite with the code in place and flag
    off: `cd internal-packages/run-engine && pnpm run test ./src/run-queue/ --run`
    (excluding the `fairness-spike*` dirs if they are still present). All
    green.

### Task 9: engine and webapp wiring (code-dark rollout)

Files: `engine/types.ts`, `engine/index.ts`, `apps/webapp/app/env.server.ts`,
`apps/webapp/app/v3/runEngine.server.ts`.

- `engine/types.ts`, inside `queue:`:
  `ckVirtualTimeScheduling?: RunQueueOptions["ckVirtualTimeScheduling"];`
- `engine/index.ts` (~line 196): pass
  `ckVirtualTimeScheduling: options.queue?.ckVirtualTimeScheduling,`.
- `env.server.ts`:
  `RUN_ENGINE_CK_VTIME_SCHEDULING_ENABLED: z.string().default("0")`,
  `RUN_ENGINE_CK_VTIME_QUANTUM: z.coerce.number().default(1)`,
  `RUN_ENGINE_CK_VTIME_WINDOW_MULTIPLIER: z.coerce.number().default(3)`,
  `RUN_ENGINE_CK_VTIME_STATE_TTL_SECONDS: z.coerce.number().default(86400)`
  (match the file's existing patterns for flag-style vars).
- `runEngine.server.ts` `queue:` block:

```ts
ckVirtualTimeScheduling:
  env.RUN_ENGINE_CK_VTIME_SCHEDULING_ENABLED === "1"
    ? {
        enabled: true,
        quantum: env.RUN_ENGINE_CK_VTIME_QUANTUM,
        scanWindowMultiplier: env.RUN_ENGINE_CK_VTIME_WINDOW_MULTIPLIER,
        stateTtlSeconds: env.RUN_ENGINE_CK_VTIME_STATE_TTL_SECONDS,
      }
    : undefined,
```

Mixed-deploy analysis to record in the PR description (the analogue of the
caps plan's mixed-arity warning): old and new instances coexist safely
because ioredis registers scripts per process, so arity never mixes within a
script call; old-instance enqueues skip registration and old-instance
dequeues neither advance tags nor GC `ckVtime`. Consequences during overlap:
unregistered variants are served via pass 2 (age order, today's behaviour)
and get registered on serve; keys served by old instances gain a temporary
priority bias (tags lag), which the floor bounds and which disappears when
the rollout completes. No state leaks: `ckVtime` entries created during a
rollout that is then rolled BACK are ignored by the old script entirely and
expire via the state TTL. Turning the flag OFF after running ON is the same:
stale vtime keys are inert and expire within `stateTtlSeconds`.

Verify: `pnpm run typecheck --filter @internal/run-engine` and
`pnpm run typecheck --filter webapp`.

### Task 10: ship notes and cleanup

- Add `.server-changes/2026-07-24-ck-fair-scheduling.md` per
  `.server-changes/README.md` (user-facing wording; it ships dark, so the
  note says the fair ordering exists behind a flag and changes nothing by
  default). No changeset (no public package touched).
- `pnpm run format && pnpm run lint:fix` before committing.
- The `fairness-spike/` and `fairness-spike-ck/` directories say "delete
  before any merge to main" in their own headers. Deleting them is a
  separate commit/decision, not part of this implementation branch; do not
  import from them (already a global constraint).

## Rollout sequence (after merge)

1. Deploy with the flag off (nothing changes; scripts for the new commands
   are registered but never called).
2. Enable on a staging/test cell; watch dequeue latency spans and Redis op
   rates against the Task-7 budget; run a manual sybil-shaped workload and
   confirm the light key's wait.
3. Enable in production. During the instance-rolling window the behaviour
   interpolates between age order and fair order per the mixed-deploy
   analysis; both endpoints are safe.
4. Rollback at any point = flip the env var off; stale vtime keys expire via
   TTL within 24h.

## Open design decisions (flagged, with recommended defaults)

1. Fast-path enqueue does not advance or register virtual time.
   Recommended: keep it that way. The fast path fires only when the variant
   queue is empty AND env and queue capacity are free, i.e. when there is no
   contention, and fairness only exists under contention. Charging fast-path
   serves would need vtime keys touched on the hot uncontended path for no
   measurable benefit. Revisit only if a workload alternates fast-path and
   queued serves on the same keys at saturation boundaries (the Task-6
   ckBalanced no-harm test would catch a regression shape here).
2. Stored tag semantics and quantum. Recommended: store the NEXT start tag
   (start of last serve + quantum), quantum 1.0, matching `SfqCk` in
   `disciplines.ts` exactly, since that is the vetted logic both spikes
   measured. A cost-proportional quantum (e.g. by machine size) is possible
   later via the same field.
3. Pass-1 window multiplier. Recommended: default 3 (today's), configurable.
   The residual reachability limit (more than `window` at-cap or
   future-scheduled low-tag variants hiding an eligible one) is the same
   class as today's `*3` limit and pass 2 keeps the call work-conserving;
   widening by default would raise per-call cost for a case not yet observed.
4. Registration sites. Recommended: enqueue and nack only, with pass 2 as
   the safety net, per the closure argument (only enqueue and nack make a
   variant queue non-empty). Adding registration to the sweeper/ack Luas
   would touch more scripts for no covered transition.
5. State TTL default. Recommended: 86400s, matching `counterTtlSeconds`'s
   precedent and rationale (periodic re-anchor bounds any drift, including
   drift from rolling-deploy overlap).
6. Command variants vs ARGV-gated single script. Recommended: separate
   `...Vtime...` commands. Byte-identity when off then holds by construction
   instead of by test.
7. Equal weights. Recommended: yes, with the `quantum / weight` hook left in
   place (weight fixed at 1, named local, comment pointing at a future
   sparse `:ckWeights` HASH shaped like Phase-2's `:ckLimits`). No product
   surface for weights exists today.
8. Discipline. Recommended: SFQ (stride is arithmetically the same thing
   here; DRR would need a ring cursor in Redis and buys nothing per the
   spike, where DRR and SFQ tracked each other within noise). Keep DRR as
   the documented O(1) fallback if ZSET ops on `ckVtime` ever show up in
   profiles, which the Task-7 op budget makes visible.

## Verification summary

```bash
pnpm run typecheck --filter @internal/run-engine
pnpm run typecheck --filter webapp
cd internal-packages/run-engine
pnpm run test ./src/run-queue/tests/keyProducer.test.ts --run
pnpm run test ./src/run-queue/tests/ckVtime.test.ts --run
pnpm run test ./src/run-queue/tests/ckVtimeFairness.test.ts --run
pnpm run test ./src/run-queue/tests/ckVtimeConcurrency.test.ts --run
pnpm run test ./src/run-queue/ --run   # full regression, flag off default
```
