# Mollifier idempotency — treat Redis as a second store for keys

**Branch:** `mollifier-phase-3`
**Date:** 2026-05-19
**Status:** Locked. (Q5 in the api-parity plan series.)
**Companion docs:** Q1 listing, Q2 replay, Q3 mutation race, Q4 cancel.

## The question

`POST /api/v1/idempotencyKeys/{key}/reset` (SDK route) and `POST /resources/.../runs/{runParam}/idempotencyKey/reset` (dashboard route) both clear an idempotency key from matching TaskRun rows. Two adjacent concerns:

1. **Reset itself.** The current `ResetIdempotencyKeyService` does `prisma.taskRun.updateMany` against PG. Buffered runs are invisible to it — a customer who resets a key during the buffered window sees the buffered run materialise *with the key still set*, defeating the reset.
2. **Trigger-time dedup.** The existing `IdempotencyKeyConcern.handleTriggerRequest` does `prisma.taskRun.findFirst` against PG only. Two triggers with the same key during the buffered window both pass the check (PG has neither yet) and create duplicate runs.

Both are surfaced by the same root cause: **idempotency keys live in PG today, and the buffer is invisible to the key-aware code paths.**

## The principle

The buffer is just another store. Keys live where the run lives. Every place the existing code consults PG for keys, also consult the buffer. Every place the existing code mutates PG keys, also mutate buffer keys.

No "secondary index" component, no new helper service. Just an additional Redis lookup that lives next to the entry hash and is maintained by the same Lua scripts that manage entries.

## Design

### The Redis lookup

```
key:    mollifier:idempotency:{envId}:{taskIdentifier}:{idempotencyKey}
value:  runId
ttl:    matches the entry hash TTL
```

One key per `(env, task, idempotencyKey)` combination. Resolves the same composite uniqueness PG enforces via the `findFirst` query.

### `accept` — atomic with entry creation

The existing `acceptMollifierEntry` Lua already serialises with the entry's lifecycle. Extend it to also write the idempotency lookup:

```lua
-- acceptMollifierEntry (revised)
local entryKey = KEYS[1]
local queueKey = KEYS[2]
local orgsKey = KEYS[3]
local idempotencyKey = ARGV[?]      -- optional
local idempotencyLookupKey = ARGV[?] -- optional, derived from envId+taskId+idempotencyKey

if redis.call('EXISTS', entryKey) == 1 then
  return 'duplicate_run_id'
end

if idempotencyLookupKey then
  -- SETNX: refuse if the key is already taken by a buffered run.
  -- Returns the existing runId for the caller to use as the cached response.
  local existingRunId = redis.call('GET', idempotencyLookupKey)
  if existingRunId then
    return { 'duplicate_idempotency', existingRunId }
  end
  redis.call('SET', idempotencyLookupKey, runId, 'EX', ttlSeconds)
end

-- ... existing accept logic (HSET entry, ZADD queue, SADD orgs/orgEnvs)
return 'accepted'
```

The SETNX gives us **trigger-time dedup during the buffered window for free**. Two simultaneous accepts with the same key — the second's Lua sees the lookup already set, returns the existing runId. Same behaviour as PG's unique constraint, but synchronous and pre-PG-insert.

### Drainer ack — atomic with materialisation

The drainer's ack Lua (per Q1: `HSET materialised=true; EXPIRE +30s`) extends to clear the idempotency lookup. PG is canonical for the key after materialisation:

```lua
-- drainer ack (revised)
HSET entryKey materialised=true
EXPIRE entryKey +30s
if entry.idempotencyKey then
  DEL idempotencyLookupKey
end
```

The lookup's TTL is the safety net if this DEL is missed for any reason — it'll TTL out within the same window as the entry hash itself.

### Trigger-time dedup — check both stores

Modify `IdempotencyKeyConcern.handleTriggerRequest`:

```ts
const existingRun = idempotencyKey
  ? await this.findExistingIdempotentRun({
      runtimeEnvironmentId: request.environment.id,
      idempotencyKey,
      taskIdentifier: request.taskId,
    })
  : undefined;
// ... rest unchanged
```

Where:

```ts
async findExistingIdempotentRun({ runtimeEnvironmentId, idempotencyKey, taskIdentifier }) {
  // 1. PG canonical check (existing behaviour).
  const pgRun = await this.prisma.taskRun.findFirst({
    where: { runtimeEnvironmentId, idempotencyKey, taskIdentifier },
    include: { associatedWaitpoint: true },
  });
  if (pgRun) return pgRun;

  // 2. Buffer check — the same key may belong to a buffered run.
  const bufferedRunId = await this.mollifierBuffer?.lookupIdempotency({
    envId: runtimeEnvironmentId,
    taskIdentifier,
    idempotencyKey,
  });
  if (!bufferedRunId) return undefined;

  // 3. Synthesise the TaskRun shape from the buffered snapshot using the
  //    existing readFallback machinery. Returned shape includes all the
  //    fields the dedup logic reads (status, idempotencyKeyExpiresAt,
  //    associatedWaitpoint, etc.).
  return await synthesiseFromBuffer(bufferedRunId);
}
```

The synthesis path is the same one Q1 uses for listing and Q2 uses for replay. No new fallback logic — just one more caller of the existing helper.

The dedup logic that follows (key expired? status indicates clear? return cached? trigger new?) runs unchanged against either source.

### Reset — operate on both stores

`ResetIdempotencyKeyService.call`:

```ts
async call(idempotencyKey, taskIdentifier, env) {
  // 1. PG-side (existing behaviour).
  const { count: pgCount } = await this.prisma.taskRun.updateMany({
    where: { idempotencyKey, taskIdentifier, runtimeEnvironmentId: env.id },
    data: { idempotencyKey: null, idempotencyKeyExpiresAt: null },
  });

  // 2. Buffer-side via a single Lua call.
  const { runId: clearedBufferedRunId } = await mollifierBuffer.resetIdempotency({
    envId: env.id,
    taskIdentifier,
    idempotencyKey,
  });

  const totalCount = pgCount + (clearedBufferedRunId ? 1 : 0);
  if (totalCount === 0) {
    throw new ServiceValidationError(
      `No runs found with idempotency key: ${idempotencyKey} and task: ${taskIdentifier}`,
      404,
    );
  }

  return { id: idempotencyKey };
}
```

The buffer-side reset is one Lua script:

```lua
-- resetIdempotencyKey Lua
local idempotencyLookupKey = KEYS[1]
local entryPrefix = ARGV[1]

local runId = redis.call('GET', idempotencyLookupKey)
if not runId then return cjson.encode({}) end

local entryKey = entryPrefix .. runId
if redis.call('EXISTS', entryKey) == 0 then
  -- Stale lookup (entry expired without the lookup being cleaned up).
  -- Lazy cleanup.
  redis.call('DEL', idempotencyLookupKey)
  return cjson.encode({})
end

-- Clear the idempotency fields on the snapshot payload.
local payloadJson = redis.call('HGET', entryKey, 'payload')
local payload = cjson.decode(payloadJson)
payload.idempotencyKey = cjson.null
payload.idempotencyKeyExpiresAt = cjson.null
redis.call('HSET', entryKey, 'payload', cjson.encode(payload))

redis.call('DEL', idempotencyLookupKey)
return cjson.encode({ runId = runId })
```

Single round-trip, atomic per-Redis-script. The customer sees the same `{ id: idempotencyKey }` response either way.

### Dashboard reset surface

`POST /resources/.../runs/{runParam}/idempotencyKey/reset` flow:

1. Resolve runId → snapshot (via existing readFallback for buffer, or PG findFirst).
2. Read the snapshot's `idempotencyKey` field.
3. If null, return "This run does not have an idempotency key" (existing message).
4. Otherwise call the same `ResetIdempotencyKeyService.call(key, taskIdentifier, env)`. The service handles both stores.

No special-case for buffered vs PG runs at the route level. The service's two-store reset is the abstraction.

## Why this works

### Trigger-time dedup is symmetric with PG semantics

The SETNX inside `acceptMollifierEntry` mirrors PG's unique-key behaviour at trigger time:

- Two simultaneous PG triggers race. One wins, the other's `findFirst` sees the winner before its own insert, returns cached.
- Two simultaneous buffered triggers race. One wins the SETNX, the other's accept-Lua sees the lookup set, returns the existing runId.
- A buffered trigger followed by a PG trigger: PG `findFirst` returns null (the row isn't in PG), then the buffer lookup hits → return cached buffered runId. ✓
- A PG trigger followed by a buffered trigger: PG `findFirst` returns the existing PG row → return cached. ✓
- A buffered trigger followed by another buffered trigger after the first has drained: PG `findFirst` returns the (now-materialised) row → return cached. Buffer lookup was cleared at materialisation, so the second buffered trigger correctly sees PG only. ✓

### Reset is symmetric too

- A key bound to a PG row: existing `updateMany` clears it.
- A key bound to a buffered run: the new buffer-side reset clears it.
- A key bound to both (during the in-flight window after drainer materialised but before its ack ran): existing `updateMany` clears PG; the buffer-side reset is a no-op (lookup already cleared by drainer ack). Counts to 1.
- A key not bound anywhere: 404 (existing behaviour, both stores return 0).

### Failure isolation

Stale lookups are bounded by the TTL match — both the entry hash and the idempotency lookup TTL at the same time. If the lookup somehow persists past the entry (e.g., the drainer ack's DEL was lost to a partial Redis write), the next access through `lookupIdempotency` returns a runId for a non-existent entry. The buffer's helper detects this and lazy-cleans:

```ts
async lookupIdempotency({ envId, taskIdentifier, idempotencyKey }) {
  const runId = await this.redis.get(/*lookup key*/);
  if (!runId) return null;
  const entry = await this.getEntry(runId);
  if (!entry) {
    await this.redis.del(/*lookup key*/);  // self-heal
    return null;
  }
  return runId;
}
```

## Behaviour table

| Scenario | Trigger response | Reset response |
|---|---|---|
| Key K bound to PG run R1 | `findFirst` hits → return R1 cached | `updateMany` clears K on R1. Returns `{ id: K }` |
| Key K bound to buffered run R1 | PG miss → buffer lookup hits → return R1 cached (synthesised) | Buffer Lua clears K on R1's snapshot + lookup DEL. Returns `{ id: K }` |
| Key K bound to PG R1 AND buffered R2 (impossible — SETNX prevents) | n/a | n/a |
| Key K bound nowhere | Returns null → new trigger proceeds | 404 (matches existing behaviour) |
| Key K bound to buffered R1, R1 drains, customer triggers with K again | PG `findFirst` hits the now-materialised R1 → return cached | n/a |
| Two simultaneous triggers, both with key K | One's accept-Lua wins SETNX. The other's accept-Lua sees the lookup, refuses, returns the winner's runId. Customer of the loser gets the winner's runId as their response. | n/a |

## Forward-compatibility under rolling update

New Redis key: `mollifier:idempotency:{envId}:{taskIdentifier}:{key}`. New Lua extension on `acceptMollifierEntry`.

Rolling-update concern: if we deploy the new acceptMollifierEntry Lua before the new trigger-time dedup logic, accept will be setting lookups that nothing reads. Harmless.

If we deploy the new trigger-time dedup before the new accept-Lua, the lookup will always be empty (nothing writes it), so the new check is a no-op until the new accept runs. Also harmless.

Reset similarly: the buffer-side reset is independent of accept. Can deploy in either order.

So the rollout is not strictly ordered — any of the three changes can ship independently and the system stays correct, just incrementally less complete until all three are deployed.

## Test coverage

Unit tests in `packages/redis-worker/src/mollifier/buffer.test.ts`:

1. `accept` with no idempotency key — no lookup written.
2. `accept` with idempotency key — lookup SET to the runId, TTL matches entry.
3. `accept` with already-bound idempotency key — Lua returns `duplicate_idempotency` with the existing runId.
4. `lookupIdempotency` hit / miss / stale (lookup points at expired entry — self-heals).
5. `resetIdempotencyKey` — clears snapshot + lookup atomically; idempotent on already-cleared.
6. Drainer ack — DELs the lookup when entry had idempotency key.

Integration tests in `apps/webapp/test/idempotency-buffered.test.ts`:

7. Trigger A with key K → buffered. Trigger B with same K — returns A's runId.
8. Trigger A with K → buffered → drain. Trigger B with K — returns A's materialised PG row.
9. Trigger A with K → buffered. Reset K. Trigger B with K — creates new buffered run B.
10. Trigger A with K → buffered. Dashboard reset on A's runId clears K from snapshot. Trigger B with K — creates new buffered run B.

## What this design does NOT cover

- Idempotency-key expiry handling — unchanged from PG-side behaviour. The existing `handleTriggerRequest` checks `idempotencyKeyExpiresAt` against the current time and clears expired keys. The buffer-side synthesis returns the same fields, so the same logic runs against either source. No new code path.
- Cross-env or cross-task idempotency — not a thing today, not introduced.
- Bulk reset (resetting many keys at once) — out of scope, no existing API surface.

## Files touched

**Modified:**
- `packages/redis-worker/src/mollifier/buffer.ts` — extend `acceptMollifierEntry` Lua, drainer ack Lua, add `lookupIdempotency` + `resetIdempotency` methods.
- `apps/webapp/app/runEngine/concerns/idempotencyKeys.server.ts` — `findExistingIdempotentRun` helper checks both stores.
- `apps/webapp/app/v3/services/resetIdempotencyKey.server.ts` — call buffer reset alongside PG `updateMany`.
- `apps/webapp/app/v3/mollifier/readFallback.server.ts` — extend snapshot-to-TaskRun synthesis to include `idempotencyKeyExpiresAt` and `associatedWaitpoint` (if not already present) for the dedup logic.

**New tests:**
- `packages/redis-worker/src/mollifier/buffer.test.ts` extensions.
- `apps/webapp/test/idempotency-buffered.test.ts`.

## What this fixes

| Bug | Today | After |
|---|---|---|
| Trigger-time dedup blind to buffer | Two rapid triggers with same K during burst → two runs created | One run, the second trigger returns the first's runId |
| Reset can't clear buffered keys | Reset succeeds on PG; buffered run materialises with key still set | Reset clears both stores; buffered run materialises without key |
| Dashboard reset on a buffered run | "Run not found" or "This run does not have an idempotency key" depending on lookup path | Resolves through readFallback, finds the key on snapshot, clears it |

## Risks

- **The SETNX on accept becomes load-bearing for idempotency correctness.** Previously, idempotency dedup was PG-only and happened pre-buffer; the buffer didn't participate. Now the buffer's accept-Lua is on the dedup critical path. Test coverage for the race cases (two simultaneous accepts) is the highest priority.
- **TTL drift between entry hash and idempotency lookup.** Both are set with the same TTL on accept, but if the entry is requeued (`requeueMollifierEntry` after a transient drainer error), the TTL extends. The lookup's TTL doesn't extend automatically. Need to extend the requeue Lua to also EXPIRE the lookup. Tiny change; flag it explicitly.
- **Migration concern.** Existing buffered runs (from prior to this change) won't have lookups in Redis. They'll fall through trigger-time dedup as if no key was bound. Acceptable transient — within the buffer TTL (10 min default), this resolves. Document in the migration notes.
