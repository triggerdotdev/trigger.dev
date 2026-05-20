# Mollifier listing & pagination design

**Branch:** `mollifier-phase-3`
**Date:** 2026-05-19
**Status:** Locked design for the listing question (Q1 from `2026-05-19-mollifier-api-parity.md`).
**Directional context:** The mollifier currently buffers a fraction of triggers (per-org flag + burst threshold). The eventual target is for *every* trigger to start its life in Redis and materialise to PG asynchronously. This design must work correctly under both states without revision.

## The problem

`client.runs.list({ limit })` and the dashboard runs table both return a paginated, `createdAt DESC` view of a customer's runs. Some of those runs are materialised in Postgres; some are still in the Redis mollifier buffer. The merged response must be:

- **Transparent.** The customer cannot tell which storage a run came from. No "Recently queued" section, no `source: "buffer"` field. Buffered runs appear as ordinary `QUEUED` entries.
- **Duplicate-free.** A run shown on page 1 from the buffer must not reappear on page 2 from PG even if the drainer materialised it between fetches.
- **Coherent under churn.** The drainer is actively `ZPOPMIN`-ing buffer entries and writing PG rows during pagination. The cursor must remain a valid resume point through that activity.
- **Scalable.** The buffer might hold five entries (steady state) or five million (extreme burst). Page-N latency must not degrade with buffer size beyond `O(log N + pageSize)`.

## Decisions

### D1. Buffer storage layer: ZSET keyed by createdAt

Replace `mollifier:queue:{envId}` from a Redis LIST to a sorted set scored by `createdAt` microseconds.

| Operation | LIST today | ZSET (new) |
|---|---|---|
| accept | `LPUSH` (O(1)) | `ZADD queue createdAtMicros runId` (O(log N)) |
| drainer pop | `LPOP` via Lua (O(1)) | `ZPOPMIN queue` via Lua (O(log N)) |
| paginated read | `LRANGE` + JS sort (O(N)) | `ZREVRANGEBYSCORE queue (watermark -inf LIMIT 0 pageSize` (O(log N + pageSize)) |
| count | `LLEN` (O(1)) | `ZCARD` (O(1)) |

ZSET adds ~20-step `log N` cost to accept and pop for N=1M. Sub-microsecond difference. Listing goes from "unacceptable above ~thousands" to "trivial at any scale."

LIST cursors would have to be index-based, and indices shift under concurrent drainer pops. ZSET cursors are `(createdAt, runId)` anchors — stable regardless of how much the drainer pops or accept pushes between fetches.

### D2. Entry hash persists past materialisation

When the drainer successfully materialises a buffered run into PG, it does **not** delete the entry hash. Instead:

```
drainer.ack:
  HSET entry materialised=true
  EXPIRE entry +30s     // grace TTL, safety net
```

This guarantees **always at least one source** for every run during its lifecycle:

- `[accept, drainer pop]`: in ZSET + in entry hash. Reads can use either; PG is empty.
- `[drainer pop, PG insert]`: in entry hash (with `status=DRAINING`); not in ZSET; PG not yet populated. Direct reads (retrieve, trace, etc.) succeed via the entry hash. Listing momentarily skips the run (~10ms).
- `[PG insert, +30s]`: in PG + in entry hash (`materialised=true`). PG is canonical; entry hash is a safety net for replica lag or other transient PG misses.
- `> +30s after materialisation`: PG only. Entry hash TTL-evicted.

The drainer's current `DEL` on ack is replaced with this `HSET materialised + EXPIRE +30s` atomic pair.

### D3. Drainer order: FIFO

Switch from LIFO (current `LPUSH` + `LPOP` both touch head, newest drains first) to FIFO via `ZPOPMIN` (oldest first). Bounded per-run latency under sustained burst; current behaviour lets the oldest buffered runs sit until TTL while newer ones drain ahead of them.

### D4. Listing presenter merges via compound cursor

Listing reads from both the ZSET buffer source and the PG presenter, merges by `createdAt DESC`, and truncates to `pageSize`. A compound cursor encodes where to resume.

The cursor remains **opaque** to the SDK — encoded as the existing base64-JSON format. Customers see no schema change.

### D5. No banner

`RecentlyQueuedSection.tsx` is deleted. The runs table surfaces buffered runs natively as ordinary `QUEUED` rows. `MollifierBuffer.countForEnv()` survives only for operator/admin dashboards (not on any customer hot path).

### D6. Per-row source attribution

Server-internal only. The merge layer tags each row with `_source: "buffer" | "pg"` for logging/metrics. Stripped before serialising to the customer. SDK and dashboard see no difference between sources.

## Cursor structure

```ts
type ListCursor = {
  // Smallest (createdAt, runId) tuple shown across all pages so far.
  // Acts as upper bound for *both* sources on subsequent pages.
  // Excludes:
  //  - runs that materialised between page-1 fetch and now
  //  - runs that were triggered after pagination started
  // Set on first page (page 2's cursor); never changes between subsequent pages.
  watermark: { createdAt: number; runId: string } | null;

  // True once the buffer source has returned fewer than pageSize entries
  // under the watermark. Once true, all subsequent page fetches skip the
  // buffer entirely. The buffer source is monotonically non-increasing
  // below the watermark — once you've seen the end of it, you can't
  // un-see it on a later page.
  bufferExhausted: boolean;
};
```

Tiebreaker comparison: `(createdAt, runId) < (X, Y)` means `createdAt < X OR (createdAt = X AND runId < Y)`. This mirrors the existing PG cursor comparator.

## Listing algorithm

```ts
async function listRuns({ envId, pageSize, cursor }: ListInput): Promise<ListOutput> {
  const watermark = cursor?.watermark ?? null;
  const bufferExhausted = cursor?.bufferExhausted ?? false;

  // Fetch from each source, bounded by the watermark on pages 2+.
  const bufferRows = bufferExhausted
    ? []
    : await fetchBufferBelowWatermark(envId, watermark, pageSize);

  const pgRows = await fetchPgBelowWatermark(envId, watermark, pageSize);

  // Merge by (createdAt DESC, runId DESC), take pageSize.
  const merged = mergeDescByCreatedAt(bufferRows, pgRows).slice(0, pageSize);

  // Strip server-internal _source tag.
  const result = merged.map(stripInternalMetadata);

  // Build cursor for next page.
  const nextCursor: ListCursor | null =
    merged.length < pageSize && bufferRows.length === 0
      ? null // genuinely exhausted both sources
      : {
          watermark: tail(merged), // (createdAt, runId) of last shown
          bufferExhausted: bufferRows.length < pageSize,
        };

  return { runs: result, nextCursor };
}

async function fetchBufferBelowWatermark(envId, watermark, pageSize) {
  if (watermark === null) {
    // Page 1: take top pageSize from ZSET.
    const runIds = await redis.zrevrangebyscore(
      `mollifier:queue:${envId}`,
      "+inf",
      "-inf",
      "LIMIT", 0, pageSize,
    );
    return await hgetallPipelined(runIds);
  }
  // Page N: strictly less than watermark.
  const entries = await redis.zrevrangebyscore(
    `mollifier:queue:${envId}`,
    `(${watermark.createdAt}`,
    "-inf",
    "LIMIT", 0, pageSize,
  );
  // ZSET ties broken by member-DESC; handle (createdAt = watermark.createdAt AND runId < watermark.runId) via a second range scan.
  // ... see Edge case T below for the tiebreaker path.
  return await hgetallPipelined(entries);
}

async function fetchPgBelowWatermark(envId, watermark, pageSize) {
  // Existing presenter path. Watermark feeds in as the cursor.
  return await runListPresenter.call({
    envId,
    cursor: watermark, // PG already understands (createdAt, friendlyId) tuples.
    limit: pageSize,
  });
}
```

## Worked examples

Notation: `B<n>=<ts>` is a buffer entry; `P<n>=<ts>` is a PG row. `pageSize=5` throughout.

### Example 1 — Small buffer, drains within first two pages

**Initial state:**

```
Buffer (ZSET):  B1=1000  B2=990  B3=980  B4=970  B5=960  B6=950  B7=940
PG:                                                                    P1=935  P2=920  P3=900  P4=850  P5=800  P6=750
```

**Page 1** (no cursor)

- Buffer: top 5 → `[B1, B2, B3, B4, B5]`.
- PG: top 5 → `[P1, P2, P3, P4, P5]`.
- Merge by createdAt DESC, take 5 → `[B1, B2, B3, B4, B5]`.
- **Cursor:** `{ watermark: (960, B5), bufferExhausted: false }` (buffer returned exactly pageSize).

**Page 2** (cursor watermark 960)

- Buffer `< (960, B5)`: `[B6=950, B7=940]`. Returned 2 < pageSize → buffer flagged exhausted.
- PG `< (960, B5)`: `[P1=935, ..., P5=800]`.
- Merge: `[B6, B7, P1, P2, P3, P4, P5]`. Take 5 → `[B6, B7, P1, P2, P3]`.
- **Cursor:** `{ watermark: (900, P3), bufferExhausted: true }`.

**Page 3** (buffer exhausted)

- Buffer fetch skipped.
- PG `< (900, P3)`: `[P4=850, P5=800, P6=750, ...]`. Take 5.

Pages 4+ pure PG.

### Example 2 — Large buffer, drainer backed up

**Initial state:**

```
Buffer:  B1=1000  B2=999  B3=998  ...  B100=901
PG:                                              P1=900  P2=895  ...
```

**Page 1** → `[B1, B2, B3, B4, B5]`. Cursor: `(996, B5)`, `bufferExhausted=false`.
**Page 2** → `[B6, B7, B8, B9, B10]`. Cursor: `(991, B10)`, `bufferExhausted=false`.
**...**
**Page 20** → `[B96, B97, B98, B99, B100]`. Cursor: `(901, B100)`, `bufferExhausted=false` (buffer returned exactly pageSize).
**Page 21** → Buffer `< (901, B100)` returns `[]`. `bufferExhausted=true`. PG returns `[P1, P2, ...]`.

From page 22 pure PG. Customer never sees the boundary — listing is continuous in `createdAt` order.

### Example 3 — Drainer materialises entries between page fetches (duplicate risk)

**T=0 state:**

```
Buffer:  B1=1000  B2=990  B3=980  B4=970  B5=960  B6=950  B7=940
PG:                                                              P1=935  P2=920  ...
```

**Page 1 at T=0** → `[B1, B2, B3, B4, B5]`. Cursor: `(960, B5)`.

**Between T=0 and T=1:** drainer materialises B1 and B2. New state:

```
Buffer:                              B3=980  B4=970  B5=960  B6=950  B7=940
PG:      B1=1000  B2=990                                                       P1=935  P2=920  ...
```

**Page 2 at T=1:**

- Buffer `< (960, B5)`: `[B6=950, B7=940]`.
- PG `< (960, B5)`: `[P1, P2, P3, P4, P5]`. **B1 and B2 are excluded** — `(1000, B1) > (960, B5)` and `(990, B2) > (960, B5)`, both fall above the watermark.
- Merge top 5 → `[B6, B7, P1, P2, P3]`.

**No duplicates.** B1 and B2 were shown on page 1 (from buffer); the watermark excludes them on page 2 (from PG). Customer sees clean continuous list.

### Example 4 — New triggers arrive after page 1

**T=0 state:** same as Example 1. Page 1 returns `[B1, ..., B5]`. Cursor: `(960, B5)`.

**Between T=0 and T=1:** customer triggers B8=1100, B9=1090. New state:

```
Buffer:  B8=1100  B9=1090  B1=1000  B2=990  ...  B7=940
```

**Page 2 at T=1:**

- Buffer `< (960, B5)`: `[B6, B7]`. B8 (1100) and B9 (1090) excluded — they're above the watermark.

B8 and B9 are *excluded from this pagination*. They arrived after the customer started paginating. Customer must refetch from page 1 to see them. **Standard pagination semantics**, matches the existing PG-only list. Documented in customer docs.

### Example 5 — Tiebreaker on identical createdAt

**Initial state:**

```
Buffer:  B1=1000  B2=1000  B3=990
```

ZSET orders by `(score DESC, member DESC)`. Assume `B2 > B1` lexicographically.

**Page 1 with pageSize=2:**

- Buffer: `[B2=1000, B1=1000]` (ZSET ties broken by member-DESC).
- **Cursor:** `{ watermark: (1000, B1), bufferExhausted: false }`.

**Page 2:**

- Need entries with `(createdAt, runId) < (1000, B1)`.
- First scan: `ZREVRANGEBYSCORE queue (1000 -inf LIMIT 0 pageSize` → `[B3=990]` (entries strictly below score 1000).
- Then scan tied-score range: `ZREVRANGEBYLEX queue (B1 - LIMIT 0 pageSize` filtered to entries with `score = 1000` (the watermark createdAt). If such entries exist (e.g., B0=1000 lex-less than B1), they precede B3 in the merged order.
- Merge results: `[<any tied entries lex-less than B1>, B3=990]`.

The two-stage tied-score scan is the canonical ZSET pagination pattern. Encapsulated in `fetchBufferBelowWatermark` so callers don't see it.

## Edge cases

### E1. New entry arrives exactly at the watermark createdAt

Page 1 cursor: `(960, B5)`. A new trigger arrives with createdAt=960 and a runId lex-greater than B5 (e.g., B5x). The new entry has score=960; tied-score scan would compare `(960, B5x) > (960, B5)` → excluded by the strict-less-than watermark. Correct: it's a new arrival, excluded from this pagination.

### E2. Drainer materialises entries during page fetch (within-fetch race)

Listing reads buffer first, then PG. If a run drains between the two reads:

- Buffer read returned it (under the watermark filter).
- PG read also returns it (now materialised).
- Merge sees the same `runId` from two sources → dedupe by `runId` before truncating to pageSize.

The merge step needs a dedupe pass keyed by `runId`. Cost: O(pageSize). Negligible.

### E3. Entry hash exists but ZSET membership is gone (in-flight window)

A run that's been popped by the drainer but not yet inserted into PG: not in ZSET (so not in buffer source), not in PG (so not in PG source). Listing skips it for ~10ms. The entry hash still exists for **direct reads** (retrieve, trace, etc.) via the existing read-fallback path. Customer refresh of listing surfaces the run from PG once the drainer's `engine.trigger` completes.

### E4. Entry hash with `materialised=true` (post-drain grace window)

After the drainer's PG insert + `HSET materialised=true; EXPIRE +30s`, the entry hash exists in Redis but the canonical state is PG. The buffer listing source must *exclude* these entries — they're already counted in the PG source and would otherwise double-show.

Two options:

- (i) `ZREM queue runId` atomically with the materialisation HSET. ZSET membership is the boundary for "in buffer source".
- (ii) Keep ZSET membership through grace TTL; have the buffer listing source filter `materialised=false` per entry. Adds a HGETALL field check.

**Choice: (i).** ZSET membership is the canonical "currently buffered" set. The post-grace entry hash exists only for direct read fallback, not for listing.

### E5. Buffer empty at page 1

- Buffer fetch returns `[]`. `bufferExhausted = true` immediately on page 1.
- Listing is pure PG from page 1 onward. No overhead vs today's PG-only list.

### E6. ZSET score precision

`createdAt` in microseconds fits comfortably in a `double` (Redis ZSET score type) for thousands of years. No precision concern at production timescales.

## Performance characteristics

| Path | Cost per page-1 request | Cost per page-N (N>1) |
|---|---|---|
| Empty buffer | 1 × ZRANGE (returns []) → buffer skipped on page 2+ | PG presenter only |
| Small buffer (< pageSize) | 1 × ZRANGE + N × HGETALL pipelined + PG presenter | PG presenter only |
| Large buffer (millions) | 1 × ZRANGE (O(log N + pageSize)) + N × HGETALL pipelined + PG presenter | Same as page 1 until buffer exhausted, then PG only |
| Cursor encode/decode | O(1) (fixed-size struct) | O(1) |

Page 1 with empty buffer adds ~1ms (single ZRANGE returning []) over the PG-only baseline. Page 1 with N=1M buffered: ~10ms (ZRANGE log-N + pipelined HGETALL pageSize times). PG presenter cost dominates either way.

## Drainer changes (companion work)

This design requires three drainer changes:

1. **Pop semantics.** Replace `LPOP queue` (in `popAndMarkDraining` Lua) with `ZPOPMIN queue`. Returns `(score, member)` instead of just `member`; the score is the entry's `createdAt` which we'd want to validate against the entry hash's stored createdAt.
2. **ack semantics.** Replace `DEL entry` with `HSET entry materialised=true` + `EXPIRE entry +30s`. Atomic via a one-shot Lua script.
3. **ZREM on materialise.** When the drainer's PG insert succeeds, atomically `ZREM queue runId` *and* HSET `materialised=true` so the buffer source no longer surfaces the run. Both done in the ack Lua.

`requeue` and `fail` paths: unchanged conceptually. `requeue` does `ZADD queue` instead of `LPUSH queue`; `fail` HSETs status=FAILED on the entry hash and removes from ZSET (already removed by `popAndMarkDraining`).

## What this resolves

- ✅ Transparency: customer cannot distinguish buffered vs PG runs.
- ✅ Duplicate-free across pages: watermark prevents materialised entries from reappearing.
- ✅ Coherent under churn: cursor anchors are stable through drainer activity.
- ✅ Scalable: O(log N + pageSize) per page regardless of buffer depth.
- ✅ Future-proof: same design works when every trigger flows through Redis.
- ✅ No SDK schema break: cursor stays opaque.
- ✅ No customer documentation overhead: nothing new to explain beyond "list is paginated."

## What remains out of scope here

This document covers only the listing/pagination question. Companion designs needed for:

- **Read endpoints** (retrieve, trace, spans, attempts, metadata-get, result, events) — separate doc.
- **Mutation endpoints** (tags, metadata-put, reschedule, replay, cancel) — separate doc, including the drainer bifurcation for cancel.
- **Dashboard internals** (resources.taskruns.* endpoints) — reuse the public-API designs.

Each subsequent doc references this one for the buffer storage and read-fallback primitives.

## Out of scope altogether

- Realtime endpoints — deferred per `_plans/2026-05-13-mollifier-electric-integration.md`.
- Worker/supervisor `engine.v1.*` endpoints — operate on running runs only.
- `batchTrigger` path — gate bypasses by design.
- V1 engine path — doesn't go through mollifier at all.
