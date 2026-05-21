# Mollifier idempotency-key claim — race fix

**Branch:** `mollifier-phase-3`
**Date:** 2026-05-21
**Status:** Design locked. Implementation pending.
**Companion:** [`2026-05-19-mollifier-idempotency-design.md`](2026-05-19-mollifier-idempotency-design.md) (Q5) — this extends it.

## Problem

Q5 assumed two simultaneous same-key triggers either both reach PG or both reach the buffer. The gate-transition window violates that: during the burst that trips the gate, the first 1..N triggers (where N = `TRIGGER_MOLLIFIER_TRIP_THRESHOLD`) pass through to PG, and triggers N+1..M get mollified. With the same idempotency key across all of them:

- PG path: engine.trigger races; one inserts, others get `RunDuplicateIdempotencyKeyError` → return the PG winner. ✓ inside-store dedup.
- Buffer path: accept Lua SETNX races; one wins the buffer SETNX, others get `duplicate_idempotency`. ✓ inside-store dedup.
- **Across stores: no coordination.** The system produces *two* distinct race-winners for the same key.

Customer-visible damage:

- Caller A receives `{ id: "run_PG" }`
- Caller B receives `{ id: "run_BUF" }` from a different point in the burst
- Both are isCached:false (both think they triggered for the first time)
- Caller B stores `run_BUF` in their DB / log / pipeline
- Drainer eventually pops `run_BUF` → engine.trigger → P2002 against `run_PG` → drainer marks buffer entry FAILED
- Caller B's subsequent operations on `run_BUF`:
  - mutations (tags, metadata) queued in the buffered window: silently lost
  - reads via API: work for ~10min via buffer fallback, then 404 forever
- Caller B has no signal that `run_BUF` was a ghost. Silent data corruption surfacing minutes later.

Found while running `scripts/mollifier-challenge/04-idempotency-collision.sh` without pre-warming the gate. The script was updated to pre-warm so the suite passes, but the underlying race is still there for real customer traffic during natural burst-transitions.

## The customer's contract

> "Same idempotency key → same runId, always."

That's what makes idempotency keys useful. Internal self-correction (drainer P2002) only cleans up internal state — it doesn't recover the customer's expectation that they have one canonical runId to track.

## Design

A **pre-gate Redis claim** that all same-key triggers serialise through, before the trigger pipeline decides PG vs buffer.

- PG's unique constraint remains the only mechanism the system *requires* for correctness.
- Redis becomes the **performance / coordination layer** for cross-store dedup. When Redis is up, no duplicate runIds. When Redis is down, the system degrades to today's behaviour (race may briefly produce a buffered duplicate, P2002 catches it).
- The mollifier already has the lookup infrastructure from B6a (`mollifier:idempotency:{env}:{task}:{key}`). This proposal repurposes it as the pre-gate claim instead of a buffer-only SETNX.

### Flow

```
Trigger arrives with idempotencyKey K:

1. runFriendlyId = generate()   // existing, triggerTask.server.ts:131

2. SETNX mollifier:idempotency:{env}:{task}:{K} = "pending" EX 30s

3. If we won the claim:
     try {
       result = runTriggerPipeline()   // gate → PG or buffer
       SET ...K = runFriendlyId EX <idempotencyKeyExpiresAt - now>
       return { id: runFriendlyId, isCached: false }
     } catch (err) {
       DEL ...K                        // free the claim for waiters
       throw err
     }

4. If we lost the claim:
     poll the key on ~20ms interval, up to safetyNetMs (default 5s)
       - value "pending" → keep polling
       - value is a runId → return { id: <that>, isCached: true }
       - key vanished → retry from step 2 (claimant errored)
       - safetyNet hit → return 503 "Idempotency claim resolution timed out"
```

Subsequent same-key triggers (after the burst settles) hit step 2 and find the key already populated with the winner's runId → return cached without ever blocking.

### Why this closes the race

- Same-key triggers serialise through SETNX. Only one trigger ever runs the pipeline; everyone else waits for its runId.
- Buffer accept and PG insert remain their own race-winners *within* their store (defence in depth), but only one of them is on the path for any given key — the winner of the upstream SETNX.
- The window between "claimant calls SETNX" and "subsequent caller polls" is nanoseconds (Redis serialises). The window between "claimant SETs runId" and "waiters see it" is one poll-interval (~20ms).

### Failure modes

| Scenario | Behaviour |
|---|---|
| Claimant crashes mid-pipeline | Claim TTL (30s) expires → waiters time out, return 503 → SDK retries → new SETNX winner |
| Claimant's pipeline errors → DEL fires | Next polling waiter sees key vanished → retries SETNX → one of them wins → proceeds |
| Redis SETNX fails (Redis down) | Log warn, skip the claim machinery → trigger pipeline runs unguarded → today's race may briefly produce a duplicate → P2002 backstop catches it |
| Redis GET fails for a waiter | Log warn, fall through to running the pipeline → may produce a duplicate but P2002 backstop applies |
| Claimant finishes, Redis SET (publishing the runId) fails | Waiters time out, return 503 → SDK retries → next claimant finds PG row via existing `IdempotencyKeyConcern` PG findFirst → returns cached |

The system is *correct* without Redis (PG unique constraint is the source of truth); Redis is the path to *perfect customer-visible dedup*.

### Performance

- Every same-key trigger: 1 Redis SETNX (~1ms locally).
- The winner: + 1 Redis SET on success (~1ms).
- Losers: a few `GET` polls (~20ms wait each, ~1-2 polls typical = 20-40ms added latency).
- Triggers WITHOUT an idempotency key: zero change.

For real customer burst patterns, the typical wait is a single poll cycle: the claimant's PG insert (or buffer accept) is fast, the SET happens, the next poll-tick on each waiter resolves.

## Implementation

### Files to touch

**Modify:**

- `apps/webapp/app/runEngine/concerns/idempotencyKeys.server.ts` — `IdempotencyKeyConcern.handleTriggerRequest`. After the existing PG findFirst + buffer.lookupIdempotency checks (which still run first for the post-burst settled case), insert the claim machinery.
- `apps/webapp/app/v3/mollifier/mollifierMollify.server.ts` — on successful `accept`, the existing SETNX behaviour in `acceptMollifierEntry` Lua becomes redundant if the claim wins. Decision: keep the inner SETNX as a belt-and-braces; on `duplicate_idempotency` the mollify path returns the inner winner. Should never fire if the pre-gate claim is working, but cheap to keep.
- `apps/webapp/app/runEngine/services/triggerTask.server.ts` — on successful `engine.trigger` PG insert, publish the runId to the claim key (best-effort).

**New:**

- `apps/webapp/app/v3/mollifier/idempotencyClaim.server.ts` — claim/publish/wait helpers. Mirror `mutateWithFallback`'s discriminated-outcome shape:

```ts
export type ClaimOutcome =
  | { kind: "claimed"; runFriendlyId: string }      // we own it, proceed
  | { kind: "cached"; runId: string }               // someone else's winner, return it
  | { kind: "timed_out" };                          // safety net exceeded

export async function claimOrAwait(
  redis: Redis,
  key: string,
  runFriendlyId: string,
  ttl: number,
  opts?: { safetyNetMs?: number; pollStepMs?: number },
): Promise<ClaimOutcome>;

export async function publishClaim(
  redis: Redis,
  key: string,
  runId: string,
  ttl: number,
): Promise<void>;

export async function releaseClaim(redis: Redis, key: string): Promise<void>;
```

### Wiring inside `IdempotencyKeyConcern.handleTriggerRequest`

```ts
if (idempotencyKey) {
  const pgRun = await this.prisma.taskRun.findFirst({ ... });   // existing
  if (pgRun) return { isCached: true, run: pgRun };

  if (!request.body.options?.resumeParentOnCompletion) {
    const buffered = await findBufferedRunWithIdempotency(...);  // existing
    if (buffered) return { isCached: true, run: buffered };
  }

  // NEW: pre-gate claim. Skip if buffer/redis unavailable.
  const buffer = getMollifierBuffer();
  if (buffer) {
    const outcome = await claimOrAwait(
      buffer.redis,
      makeIdempotencyClaimKey(...),
      runFriendlyId,
      ttl,
    );
    if (outcome.kind === "cached") {
      // Synthesise a cached-run response shaped like the PG/buffer paths
      // return so the rest of the trigger pipeline can short-circuit.
      const synthetic = await resolveCachedRun(outcome.runId, ...);
      return synthetic
        ? { isCached: true, run: synthetic }
        : { isCached: false, idempotencyKey, idempotencyKeyExpiresAt };
    }
    if (outcome.kind === "timed_out") {
      throw new ServiceValidationError("Idempotency claim resolution timed out", 503);
    }
    // outcome.kind === "claimed" → continue to existing pipeline below
    request._idempotencyClaimOwned = true;   // signal for publish on success
  }
}
return { isCached: false, idempotencyKey, idempotencyKeyExpiresAt };
```

### Wiring for the publish

After successful `engine.trigger` in `triggerTask.server.ts` (V2 path), AND after successful `mollifyTrigger.accept`:

```ts
if (request._idempotencyClaimOwned) {
  await publishClaim(redis, claimKey, runFriendlyId, ttl)
    .catch((err) => logger.warn("idempotency claim publish failed", { err }));
}
```

On any pipeline error before publish:

```ts
if (request._idempotencyClaimOwned) {
  await releaseClaim(redis, claimKey).catch((err) =>
    logger.warn("idempotency claim release failed", { err })
  );
}
```

### Tests

Unit tests in `apps/webapp/test/mollifierIdempotencyClaim.test.ts`:

1. SETNX wins → `claimed` returned.
2. SETNX loses, value is already a runId → `cached` returned immediately.
3. SETNX loses, value is "pending" → poll until it flips → `cached` returned.
4. SETNX loses, key TTLs out mid-poll → retry SETNX → win → `claimed`.
5. SETNX loses, never resolves → `timed_out` after safetyNetMs.
6. publishClaim writes the runId.
7. releaseClaim DELs the key.

Integration test in `apps/webapp/test/api/idempotency-claim-burst.test.ts` — fire N same-key triggers under various gate states, assert all responses converge on a single runId.

Bash regression in `scripts/mollifier-challenge/04-idempotency-collision.sh` — remove the pre-warm hack; assert that N same-key triggers during a cold-gate burst still produce one runId.

## Sub-decisions

| # | Question | Resolution |
|---|---|---|
| 1 | Claim TTL | 30s. Bounded by typical PG insert + buffer accept time + small margin. Shorter risks claimants legitimately taking longer than the TTL; longer risks waiters hanging on crashed claimants. |
| 2 | Wait safetyNetMs | 5s. Matches the upper bound a customer SDK would tolerate before retry. |
| 3 | Pre-publish "pending" value vs publishing runId immediately | "pending". Two-stage state lets a waiter distinguish "someone is working on this" from "the answer is this runId". A claimant can DEL the key on error and the next polling waiter retries SETNX cleanly. |
| 4 | What about `resumeParentOnCompletion` (triggerAndWait)? | Skip the claim machinery. triggerAndWait already bypasses the buffer gate (F4), so it goes to PG; its existing PG-side dedup handles concurrent triggerAndWait calls with the same key. Adding the claim there opens a different rabbit hole. |
| 5 | What happens to the buffer-side SETNX inside `acceptMollifierEntry` Lua (B6a)? | Keep it. Defence in depth — if the pre-gate claim somehow misses, the inner SETNX still serialises buffer-side accepts. Should never observe a `duplicate_idempotency` outcome from accept in practice. |

## What this does *not* fix

- The PG `findFirst` replica-lag race: the existing `IdempotencyKeyConcern` PG check uses `this.prisma` (writer). Already correct.
- Cross-environment / cross-task idempotency: not a thing today, not introduced.
- Customer's own client-side retries with backoff that exceeds claim TTL: SDK retries within TTL hit cached fine; retries outside TTL race like fresh requests (rare and bounded).

## Out of scope

- Distributed-coordination scenarios (multiple Redis instances, cluster mode) — claim key is per-env so hash-tag co-location is straightforward when needed.
- Observability (metrics) — Phase F1 tightening can add `mollifier.idempotency_claim_{wins,waits,timeouts}` counters.

## Resume guidance for a future session

1. Read this doc.
2. Read the Q5 doc to understand the existing buffer-side idempotency lookup (`MollifierBuffer.lookupIdempotency`, `resetIdempotency`).
3. Implement `idempotencyClaim.server.ts` per the sketch above.
4. Wire `IdempotencyKeyConcern` to use it.
5. Wire publish/release in the trigger pipeline + mollifyTrigger.
6. Tests per the section above.
7. Validate by removing the pre-warm hack from `scripts/mollifier-challenge/04-idempotency-collision.sh` and confirming the script still passes with the gate in a cold state.

Estimated effort: 1-2 days of focused work. Risk: low (Redis-side primitives all exist; the integration is the work).
