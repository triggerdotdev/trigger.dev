# Mollifier mutation race — wait-and-bounce design

**Branch:** `mollifier-phase-3`
**Date:** 2026-05-19
**Status:** Locked. (Q3 in the api-parity plan series.)
**Companion docs:** `2026-05-19-mollifier-listing-design.md` (Q1), `2026-05-19-mollifier-replay-design.md` (Q2).

## The question

A customer mutation API call (`tags`, `metadata-put`, `reschedule`, `cancel`) lands while the drainer is mid-flight on the same run. The risky window:

```
T0: drainer ZPOPMIN queue + HSET status=DRAINING  (Lua atomic)
T1: drainer JS holds snapshot in memory
T2: drainer JS calls engine.trigger(snapshot)
T3: engine.trigger inserts PG row
T4: drainer HSET materialised=true + EXPIRE +30s   (ack)
```

The drainer's in-memory snapshot at T1-T3 is a JS copy of the entry hash at T0. If the API HSET-patches the entry hash anywhere in `[T0, T2]`, the patch lands in Redis but the drainer's engine.trigger uses the stale in-memory copy. PG row gets created without the patch.

## Locked design

**Two paths through the mutation. Three outcomes from the Lua. One safety-net cap. No new infrastructure.**

### The mutation flow

```typescript
async function mutate(runId, patch, opts = {}) {
  // Path 1: PG already canonical.
  const pgRow = await prisma.taskRun.findFirst({ where: { friendlyId: runId } });
  if (pgRow) return pgMutation(pgRow);

  // Path 2: buffer entry is QUEUED → patch the snapshot. Drainer's pop
  // will read the patched payload.
  const result = await buffer.mutateSnapshot(runId, patch);
  if (result.kind === "applied_to_snapshot") return synthesisedResponse(patch);

  if (result.kind === "not_found") {
    // Disambiguate genuine 404 from replica lag via writer-side check.
    const writerRow = await prismaWriter.taskRun.findFirst({ where: { friendlyId: runId } });
    if (writerRow) return pgMutation(writerRow);
    throw new Response("Run not found", { status: 404 });
  }

  // result.kind === "busy" → drainer popped or already materialised.
  // Wait for the drainer to terminate the entry into PG (success or
  // SYSTEM_FAILURE), then route through the existing PG mutation service.
  const pgRowAfterWait = await waitForDrainerResolution(runId, opts.abortSignal);
  if (pgRowAfterWait) return pgMutation(pgRowAfterWait);

  // Drainer never resolved within the safety net — genuine outage.
  metrics.mutationSafetyNetExceeded.inc({ endpoint: patch.endpoint });
  throw new Response("Run materialisation timed out", { status: 503 });
}

async function waitForDrainerResolution(
  runId: string,
  abortSignal: AbortSignal,
  opts = { safetyNetMs: 2_000, stepMs: 20, pgTimeoutMs: 50 },
) {
  const deadline = Date.now() + opts.safetyNetMs;
  while (Date.now() < deadline && !abortSignal.aborted) {
    // Writer-side, not replica — defeats replica lag.
    const row = await pgFindWithTimeout(prismaWriter, runId, opts.pgTimeoutMs);
    if (row) return row;
    await sleep(opts.stepMs);
  }
  return null;
}
```

### The Lua script

```lua
-- mutateSnapshot(entryKey, patchType, patchData)
local entry = redis.call('HGETALL', entryKey)
if #entry == 0 then return 'not_found' end

local h = {}
for i = 1, #entry, 2 do h[entry[i]] = entry[i+1] end

if h.status == 'QUEUED' and h.materialised ~= 'true' then
  local payload = cjson.decode(h.payload)
  applyPatchToPayload(payload, patchType, patchData)
  redis.call('HSET', entryKey, 'payload', cjson.encode(payload))
  return 'applied_to_snapshot'
end

-- DRAINING / FAILED / materialised=true all collapse here.
return 'busy'
```

Three return codes. The API doesn't need to know *why* the buffer can't accept the patch — only that it can't. The drainer is racing to a terminal PG state (success or SYSTEM_FAILURE) either way, and the wait handles both uniformly.

## Why this is the right shape

### No new infrastructure

Compared to the earlier transactional-bundle proposal, this design *removes*:

- `pending_patches` list on the entry hash.
- Version-aware ack Lua.
- Drainer's `drainPendingPatches` step.
- `engine.trigger` refactor to expose `triggerPgPortion(tx)`.
- Idempotency requirement on patch application.
- Pop-version / latest-version counters.

What's kept from the broader design:

- Persistent entry hash past materialisation (per Q1).
- Drainer's existing two terminal outcomes: `materialised=true` (success) or `status=FAILED` + SYSTEM_FAILURE PG row (failure).
- `mutateSnapshot` Lua, simplified to two cases.

### The wait converges deterministically on drainer completion

The drainer always terminates an entry in one of two ways:

1. **Success path:** `engine.trigger` inserts PG row, drainer HSETs `materialised=true`. PG findFirst hits.
2. **Failure path:** `engine.trigger` throws terminal error, drainer calls `engine.recordBufferedRunFailure` which writes SYSTEM_FAILURE PG row, then HSETs `status=FAILED`. PG findFirst still hits (the SYSTEM_FAILURE row).

Either way the next writer-side PG findFirst will hit. The wait length is bounded by the drainer's actual work time, not an artificial budget. Typical drainer dwell: 10-50ms; tail: a few hundred ms under contention with retry backoff.

### Existing mutation services own terminal-state semantics

After the wait, we route through the *existing* PG mutation service for each endpoint:

| Endpoint | Service called after wait | Behaviour on terminal-state PG row |
|---|---|---|
| `tags` POST | existing tag-setter | accepts on any status (tags are metadata) |
| `metadata` PUT | existing metadata-setter | accepts on any status |
| `reschedule` POST | `RescheduleTaskRunService` | refuses if `status !== "DELAYED"` (existing behaviour) |
| `cancel` v2 POST | `CancelTaskRunService` | idempotent on already-cancelled; existing behaviour |

The customer sees whatever the PG-side endpoint already returned for that final status. **Buffered path inherits PG semantics for free.** No new policy decisions per endpoint.

### Safety net handles genuine drainer outages

The 2-second cap (`safetyNetMs`) is generous — roughly 20× typical drainer work time. It exists for one purpose: **bound the customer's wait when the drainer is genuinely hung**, so:

- Customer's HTTP connection is released within 2s rather than holding for the LB timeout (~60s).
- Server's connection pool doesn't get exhausted by piled-up waits during a drainer outage.
- We control the response body — clean `503 { error: "Run materialisation timed out" }` rather than a generic LB 504.
- Ops gets an actionable metric (`mollifier.mutation_safety_net_exceeded`) that alerts specifically on drainer health.

Under healthy ops the safety net never fires. The wait completes in tens of ms.

The abort signal (`getRequestAbortSignal()`, per `apps/webapp/CLAUDE.md`) is the secondary primitive — it covers client-disconnect cleanup so we don't keep polling for a customer who's already given up.

## Per-patch-type details

### `append_tags`

```lua
applyPatchToPayload(payload, 'append_tags', data):
  payload.tags = payload.tags or {}
  for _, t in ipairs(cjson.decode(data).tags) do
    -- de-dupe: existing tags shouldn't multiply on snapshot rewrite
    if not contains(payload.tags, t) then
      table.insert(payload.tags, t)
    end
  end
```

PG-side service already handles tag dedup. Snapshot side mirrors.

### `set_metadata`

```lua
applyPatchToPayload(payload, 'set_metadata', data):
  local d = cjson.decode(data)
  payload.metadata = d.metadata
  payload.metadataType = d.metadataType
```

Last-write-wins. Multiple snapshot patches in quick succession: latest Lua execution wins (Lua atomicity preserves arrival order).

### `set_delay`

```lua
applyPatchToPayload(payload, 'set_delay', data):
  payload.delayUntil = cjson.decode(data).delayUntil
```

Snapshot mutation only accepted when status=QUEUED (i.e., before drainer pop). If the customer wants to reschedule a DRAINING run, it goes through the wait-then-PG path — at which point `RescheduleTaskRunService` enforces the `status !== "DELAYED"` check and 400s the customer. Correct behaviour without us thinking about it.

### `mark_cancelled`

```lua
applyPatchToPayload(payload, 'mark_cancelled', data):
  local d = cjson.decode(data)
  payload.cancelledAt = d.cancelledAt
  payload.cancelReason = d.cancelReason
```

The drainer's bifurcation logic (per Q4) reads these fields and routes to `engine.createCancelledRun` instead of `engine.trigger`. The cancel-while-buffered case is the *only* one that needs drainer-side branching; tags/metadata/reschedule all flow through unchanged.

## Worked scenarios

### Scenario A — happy buffer path

1. T0: customer calls `tags.add(T1)`. Buffer entry is QUEUED.
2. T0: Lua patches `payload.tags = [T1]`. Returns `applied_to_snapshot`. API returns 200.
3. T1: drainer pops, reads snapshot with `[T1]`, calls engine.trigger.
4. T2: PG row created with `runTags = [T1]`.

One Redis Lua + synthesised 200. No PG round trip.

### Scenario B — busy path, drainer succeeds

1. T0: drainer pops, HSET status=DRAINING.
2. T1: customer calls `tags.add(T1)`. Lua returns `busy`.
3. T1: API enters `waitForDrainerResolution`.
4. T2 (T0+20ms): drainer's engine.trigger inserts PG row. HSET materialised=true.
5. T3 (T1+20ms): wait's PG findFirst hits. Returns row.
6. T3: pgMutation runs existing tag-setter against the row. PG `runTags = [T1]`. API returns 200.

Customer-visible latency: ~20-40ms over baseline. Indistinguishable from a slow PG operation.

### Scenario C — busy path, drainer fails

1. T0: drainer pops, HSET status=DRAINING.
2. T1: customer calls `tags.add(T1)`. Lua returns `busy`.
3. T1: API enters `waitForDrainerResolution`.
4. T2: drainer's engine.trigger throws terminal error.
5. T3: drainer calls `engine.recordBufferedRunFailure`. SYSTEM_FAILURE PG row written. HSET status=FAILED.
6. T4: wait's PG findFirst hits the SYSTEM_FAILURE row.
7. T4: pgMutation runs existing tag-setter. Tags accepted (any status). Customer sees 200 with tags applied to the failed run.

If the customer's mutation were `reschedule`, step 7 would 400 because `RescheduleTaskRunService` refuses non-DELAYED. Correct PG-side semantics applied.

### Scenario D — concurrent mutations

1. T0: customer A calls `tags.add(T1)`. Lua runs first, patches snapshot.tags=[T1]. Returns 200.
2. T1: customer B calls `tags.add(T2)`. Lua runs after A's. Reads snapshot.tags=[T1], appends T2, sets snapshot.tags=[T1, T2]. Returns 200.
3. T2: drainer pops snapshot with `[T1, T2]`. PG row created with `runTags = [T1, T2]`.

Lua atomicity serialises per-runId mutations. Order preserved.

### Scenario E — mutation lands exactly during drainer pop

1. T0: drainer's `popAndMarkDraining` Lua starts.
2. T0+ε: customer's `mutateSnapshot` Lua queues.
3. Redis Lua single-threadedness: one runs to completion, then the other.
4. **If drainer's pop runs first:** entry transitions QUEUED→DRAINING. Customer's Lua sees DRAINING, returns `busy`. API enters wait.
5. **If customer's Lua runs first:** patches snapshot. Drainer's pop reads patched payload.

No interleaving possible; outcome is deterministic per Redis-script order.

### Scenario F — drainer hung

1. T0: customer calls `tags.add(T1)`. Buffer is DRAINING. Lua returns `busy`.
2. T0+2s: wait deadline. PG findFirst still misses. abortSignal not fired.
3. T0+2s: API returns 503.
4. Metric `mollifier.mutation_safety_net_exceeded{endpoint=tags}` increments. Alert fires.
5. Customer SDK retries. Drainer may have recovered; if so, the retry succeeds.

Capacity protection: customer's connection released within 2s. During a drainer outage, the API serves 503s quickly rather than piling up waits.

## Metrics

| Metric | Type | When | Use |
|---|---|---|---|
| `mollifier.mutation_applied_to_snapshot{endpoint}` | counter | Lua returned `applied_to_snapshot` | Happy buffer path rate |
| `mollifier.mutation_waited_for_drain{endpoint}` | counter | API entered the wait loop | Race observation rate |
| `mollifier.mutation_wait_dwell_ms{endpoint}` | histogram | After wait completes (success or 503) | Drainer tail latency in practice; helps tune safety net |
| `mollifier.mutation_safety_net_exceeded{endpoint}` | counter | 503 emitted | Drainer health alert — should be near-zero |

The `wait_dwell_ms` histogram is the most operationally valuable — it shows the drainer's tail latency under real traffic. If p99 creeps toward the safety net, we know to either tune the cap or scale the drainer.

## Forward-compatibility under rolling update

Per the rolling-update concern Matt flagged in the May-15 review meeting:

- **No new entry-hash fields added by this design.** The `mutateSnapshot` Lua only writes to `payload` (existing field). No semantic-bearing fields the drainer needs to know about.
- **New Lua return codes:** `not_found`, `applied_to_snapshot`, `busy`. If the drainer changes how it sets `status` or `materialised` (e.g., adds a new state), the Lua's "DRAINING / FAILED / materialised=true" check would need updating — but the API's three-bucket handling stays stable. Drainer-first rollout: deploy drainer that uses the new state before deploying the API that handles it.
- **Snapshot payload schema:** mutations write known fields (`tags`, `metadata`, `metadataType`, `delayUntil`). Adding new patch types in future requires updating the Lua's `applyPatchToPayload` dispatch — but adding new patch types is itself a deploy-coordinated change.

`BufferEntrySchema` uses Zod's default strip behaviour (audited — no `.strict()`), so adding new entry-hash fields in future won't crash older drainers. Confirmed safe.

## What this design does NOT cover

- **Cancel drainer-bifurcation** — Q4. The `mark_cancelled` patch type writes `cancelledAt`/`cancelReason` to the snapshot. The drainer's branching logic (`if snapshot.cancelledAt: engine.createCancelledRun else: engine.trigger`) is designed there.
- **Idempotency-key reset** — Q5. Needs PG-side audit before deciding the buffered-side approach.
- **Listing transparency** — Q1. Buffered runs appear in `client.runs.list()` via ZSET + cursor merge.
- **Replay** — Q2. Reuses snapshot resolution; no race-handling needed.

## Operational tuning

`safetyNetMs = 2000` is the starting value. The `wait_dwell_ms` histogram will reveal whether it should move:

- If p99 wait < 200ms in production: safety net can shrink (faster fast-fail under outage). Probably not worth doing — generous is fine.
- If p99 wait creeps toward 2000ms: drainer is under-resourced. Scale the drainer service rather than stretching the cap.
- If `safety_net_exceeded` ticks up regularly: drainer health issue, page someone. Don't increase the cap.

`pgTimeoutMs = 50` per poll is conservative — one slow PG query doesn't burn the whole safety-net budget. `stepMs = 20` gives ~100 poll iterations before the cap, plenty to catch any normal drainer completion.
