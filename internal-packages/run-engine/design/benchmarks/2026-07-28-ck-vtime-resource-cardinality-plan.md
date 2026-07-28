# CK virtual-time scheduling: Redis CPU + memory vs cardinality test plan

Answers the review question: how do these changes affect the run-queue Redis
CPU and memory, and how do both react as concurrency-key cardinality grows (e.g.
a base queue that suddenly has 10k distinct concurrency keys)?

This is a cost/scaling plan, separate from the fairness A/B
(`results-2026-07-27.md`). Same environment constraints: run on a single box, all
numbers **relative** (flag OFF vs ON, identical load, same box), against a
dedicated throwaway Redis.

## What the change adds to Redis (grounded in the branch)

Per base queue, flag ON adds:

- `:ckVtime`, a ZSET whose members are the exact same full CK-variant queue-name
  strings the existing `:ckIndex` ZSET already holds, each with an 8-byte double
  score. So it is effectively a second copy of `ckIndex`'s membership.
- `:ckVtimeFloor`, a STRING holding one number. Negligible.

Both are GC'd from the dequeue path when a variant drains, carry a 24h TTL, and
live under the base queue's `{org}` hash tag. The per-call dequeue scan window is
`maxCount * windowMultiplier` (default 30) and does **not** grow with cardinality;
the cardinality-sensitive operations are the ZSET writes/reads (`ZADD` `NX`,
`ZSCORE`, `ZRANGE` by rank, `ZRANGE 0 0`), which are O(log N) on the `ckVtime`
skiplist.

## Hypotheses

1. **Memory grows linearly with cardinality, adding roughly one `ckIndex`-sized
   ZSET per base queue.** Incremental `used_memory` under ON minus OFF should
   track `cardinality x per-member cost`, and `MEMORY USAGE :ckVtime` should be
   close to `MEMORY USAGE :ckIndex` for the same queue (same members, one extra
   double score). At 10k keys on one queue this is a low single-digit MB for that
   queue, bounded and TTL-reclaimed. There is a one-step jump at the
   listpack->skiplist encoding boundary (128 entries by default).
2. **Redis CPU per operation grows sub-linearly (about O(log cardinality)), not
   linearly.** The fixed 30-entry window scan dominates the vtime-specific work
   and does not change with N; the ZSET ops add a `log N` term. So dequeue/enqueue
   `usec_per_call` should rise only mildly from 100 to 10k keys, and the ON/OFF
   `usec_per_call` ratio should stay roughly flat across the sweep.
3. **Tombstone drift stays bounded under high-cardinality churn.** `ack`, TTL
   expiry, and DLQ drain a variant without removing it from `ckVtime` (documented
   in `CK_VTIME_KNOWN_LIMITATIONS.md`). Under churn where variants drain via those
   paths rather than a vtime dequeue, `ckVtime` may transiently exceed `ckIndex`,
   but it should self-heal (next vtime pass GCs empties) or expire (24h TTL), so
   `size(ckVtime) / size(ckIndex)` stays bounded and does not grow without limit.

## Scenarios

All on a single base queue (worst case for one queue's ZSETs), dedicated Redis,
flag OFF then ON with identical load.

- **Cardinality sweep (memory).** Enqueue N distinct concurrency keys, one
  message each, N in {100, 1_000, 10_000, 50_000}. Measure the Redis memory
  footprint at rest for each N, OFF vs ON. This isolates the storage cost with no
  dequeue activity.
- **Steady-state load (CPU).** At each N, after building cardinality, run a fixed
  60s workload of enqueue + batched dequeue (`maxCount 10`) + ack at a capped
  concurrency, so keys are continuously served and re-registered. Measure Redis
  CPU and per-command time over the window, OFF vs ON.
- **Churn / tombstone (memory under adversarial drain).** Build 10k keys, then
  drain them via `ack` (not via vtime dequeue) while enqueuing new keys, for a
  fixed duration. Sample `size(ckVtime)` and `size(ckIndex)` over time and confirm
  the ratio stays bounded (self-heal + TTL), not monotonically growing.

## Metrics and collection (exact commands)

Use a second plain Redis client for measurement so it does not perturb the
harness. `redis-cli` shown; the harness issues the same via ioredis.

Memory:

- Totals: `INFO memory` -> `used_memory`, `used_memory_dataset`. Delta ON vs OFF
  at each N is the incremental footprint.
- Per structure (exact bytes): `MEMORY USAGE {org...}:queue:<base>:ckIndex` and
  `MEMORY USAGE {org...}:queue:<base>:ckVtime`. Report both and the ratio.
- Encoding: `OBJECT ENCODING <ckVtime key>` (listpack vs skiplist) at each N, to
  mark the transition.

CPU:

- Process CPU over the load window: `INFO cpu` -> `used_cpu_user` +
  `used_cpu_sys`, sampled before and after the fixed 60s load; the delta is Redis
  CPU-seconds consumed. Divide by op count for CPU-per-op.
- Per-command time: `CONFIG RESETSTAT` before the window, then `INFO commandstats`
  after -> `cmdstat_zadd`, `cmdstat_zrange`, `cmdstat_zrangebyscore`,
  `cmdstat_zscore`, `cmdstat_get`, `cmdstat_set`, `cmdstat_expire`
  (`calls`, `usec`, `usec_per_call`). Compare OFF vs ON.
- Cross-check (optional, OS-level): `pidstat -p <redis-pid> 1` over the window, or
  `redis-cli --latency` / `--latency-history` for command latency.

Derived:

- Memory vs N curve (expect linear, slope ~ per-member bytes), OFF and ON.
- CPU-per-op vs N curve (expect flat-ish / log), OFF/ON ratio.
- `size(ckVtime)/size(ckIndex)` over time in the churn scenario (expect bounded).

## A/B procedure

1. Dedicated throwaway Redis; `FLUSHDB` between arms and between cardinality
   points. Warm up once.
2. For each N in the sweep, for each arm (OFF, ON):
   - Build N keys (enqueue N distinct concurrency keys).
   - Snapshot memory (`used_memory`, `MEMORY USAGE` of both ZSETs, `OBJECT
     ENCODING`).
   - `CONFIG RESETSTAT`; run the fixed 60s steady load; snapshot `INFO cpu` and
     `INFO commandstats`.
   - Record, then `FLUSHDB`.
3. N trials of the load window per point; report median for CPU (memory at rest is
   near-deterministic).
4. Run the churn scenario once per arm at N = 10k.

Only the OFF-vs-ON delta and the shape of the growth curves are reported; absolute
throughput on a single box is not prod scale.

## Results template

### Memory at rest, per cardinality (single base queue)

| keys (N) | used_memory OFF | used_memory ON | delta | MEMORY USAGE ckIndex | MEMORY USAGE ckVtime | ckVtime/ckIndex | ckVtime encoding |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | | | | | | | |
| 1,000 | | | | | | | |
| 10,000 | | | | | | | |
| 50,000 | | | | | | | |

### Redis CPU under 60s steady load, per cardinality

| keys (N) | CPU-sec OFF | CPU-sec ON | delta | dequeue usec/call OFF | dequeue usec/call ON | delta | total redis calls OFF/ON |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | | | | | | | |
| 1,000 | | | | | | | |
| 10,000 | | | | | | | |

### Tombstone drift (N=10k, drain via ack)

| elapsed | size(ckIndex) | size(ckVtime) | ratio |
| --- | --- | --- | --- |
| 0s | | | |
| 30s | | | |
| 60s | | | |

## Harness

Extend the existing micro-benchmark
(`../../src/run-queue/bench/ckMicroBench.bench.test.ts`), which already drives a
real `RunQueue` against an external Redis and reads `INFO commandstats`. Add a
resource/cardinality mode that: builds N variants, snapshots `used_memory` +
`MEMORY USAGE` of the base queue's `ckIndex`/`ckVtime` + `OBJECT ENCODING`, runs a
fixed-duration steady load while sampling `INFO cpu`/`commandstats`, and emits the
tables above. The churn scenario reuses the same enqueue/ack primitives with a
drain-by-ack loop and periodic `ZCARD` sampling of both ZSETs.

Reuse the same dedicated Redis and the OFF-vs-ON constructor-flag pattern, so this
arm, like the micro-benchmark, needs no webapp or redeploy.
