# CK virtual-time scheduling: Redis CPU + memory vs cardinality (2026-07-28)

Answers the review question: how do these changes affect the run-queue Redis CPU
and memory, and how do both react as concurrency-key cardinality grows?

Run on a **local homelab box, not production**, against a dedicated Redis
configured for measurement (no RDB/AOF in the sampling windows, `maxmemory 0`,
zset listpack thresholds at their defaults so the encoding boundary sits at 128).
All numbers are **relative** (flag OFF vs ON, identical load, same box); absolute
throughput is not prod scale. Method: `2026-07-28-ck-vtime-resource-cardinality-plan.md`.
Server-side metrics (`INFO memory`/`cpu`/`commandstats`, `MEMORY USAGE`,
`OBJECT ENCODING`) are RTT-independent.

## Memory at rest (single base queue, one queued message per key)

| keys (N) | used_memory OFF | used_memory ON | ON-OFF delta | ckIndex | ckVtime | ckVtime/ckIndex | ckVtime encoding |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 1.84 MB | 1.93 MB | +0.09 MB | 6.9 KB | 6.2 KB | 0.89 | listpack |
| 1,000 | 2.42 MB | 2.58 MB | +0.15 MB | 131 KB | 131 KB | 1.00 | skiplist |
| 10,000 | 9.12 MB | 10.4 MB | +1.26 MB | 1.42 MB | 1.42 MB | 1.00 | skiplist |
| 50,000 | 39.1 MB | 45.6 MB | +6.51 MB | 7.55 MB | 7.54 MB | 1.00 | skiplist |

The `:ckVtime` ZSET is the whole added footprint, and it is essentially a second
copy of `:ckIndex`: same members (the full CK-variant queue names), one extra
8-byte score, so `MEMORY USAGE(ckVtime) ~= MEMORY USAGE(ckIndex)` once past the
listpack boundary. Cost is linear in cardinality at roughly **150 bytes per
concurrency key** on top of the index the queue already keeps: about +1.3 MB for
a queue with 10k keys, +6.5 MB at 50k. It is bounded by live cardinality (entries
are GC'd when a variant drains) and expires on the 24h state TTL. The
`used_memory` delta tracks the direct `MEMORY USAGE(ckVtime)` figure to within
allocator noise. The listpack->skiplist transition lands between 100 and 1,000
keys as expected.

## Redis CPU under an identical workload (2,000 rounds, ~42k script calls)

Same logical workload both arms (enqueue + batched dequeue + ack), so the
`evalsha` call count is identical and the difference is pure vtime overhead. Note
the RunQueue Lua runs as `EVALSHA`, so per-`redis.call` costs inside a script are
not separable in `commandstats`; the reportable signals are total Redis CPU and
aggregate `evalsha` time per call.

| keys (N) | CPU-sec OFF | CPU-sec ON | delta | overhead | evalsha usec/call OFF | evalsha usec/call ON |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | 1.34 | 1.49 | +0.15 | +12% | 22.3 | 26.2 |
| 1,000 | 1.34 | 1.44 | +0.10 | +7% | 22.2 | 24.8 |
| 10,000 | 1.38 | 1.45 | +0.07 | +5% | 23.8 | 25.8 |

CPU overhead does not grow with cardinality, it shrinks: +12% at 100 keys down to
+5% at 10k. Per-script cost stays roughly flat (about +2 to +4 usec/call, ~25
usec/call at every cardinality), which is what the design predicts: the pass-1
dequeue window is fixed (`maxCount * multiplier`, default 30) and independent of
N, and the added ZSET ops are O(log N), so `log2(10000) ~= 13` adds a negligible
constant. The overhead falls as a percentage because that fixed per-call cost is
amortised over more work as the queue grows.

## Membership under sustained churn (N = 10,000, flag ON)

60 rounds of continuous registration + drain (fresh keys enqueued while others
are served and acked), holding cardinality at 10k:

| round | ckIndex card | ckVtime card | ratio |
| --- | --- | --- | --- |
| 0 | 10,000 | 10,000 | 1.0 |
| 20 | 10,000 | 10,000 | 1.0 |
| 40 | 10,000 | 10,000 | 1.0 |
| 59 | 10,000 | 10,000 | 1.0 |

`ckVtime` membership tracks `ckIndex` exactly throughout: no tombstone
accumulation, no unbounded growth. The bounded/self-healing drift the limitations
doc calls out (ack/TTL/DLQ draining a variant without a vtime GC) stays reclaimed
by the next vtime pass and the state TTL.

## Bottom line for the cardinality question

- **Memory** grows linearly with concurrency-key cardinality, adding one
  `ckIndex`-sized ZSET per base queue (~150 B/key): a low-single-digit MB even at
  10k keys on one queue, bounded by live cardinality and TTL-reclaimed. A sudden
  10k-key queue costs about +1.3 MB for that queue.
- **CPU** overhead is small and does not scale with cardinality: ~+5 to +12% on
  an identical workload, per-script cost flat at ~+2 to +4 usec/call regardless of
  N, because the dequeue scan window is fixed and the ZSET ops are O(log N).
- **No runaway state**: `ckVtime` never outgrows `ckIndex` under sustained churn.
