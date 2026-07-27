# CK virtual-time scheduling: prod-like A/B benchmark plan

A method for producing defensible A/B numbers for the concurrency-key
virtual-time (SFQ) scheduling change, run on a single prod-shaped box. The two
arms are flag OFF (today's age-ordered CK dequeue) and flag ON (virtual-time
ordering), under identical load.

## What the change is (grounded in the branch)

The concurrency-key dequeue used to serve variants of a base queue in head-message
age order. Behind `RUN_ENGINE_CK_VTIME_SCHEDULING_ENABLED` (off by default) it now
orders them by start-time fair queueing (SFQ) virtual time:

- Each CK variant carries a virtual clock in a parallel `:ckVtime` ZSET; a
  monotonic floor lives in `:ckVtimeFloor`. Both sit under the base queue's
  `{org}` hash tag, so one atomic Lua script touches all of a queue's state.
- The dequeue runs two passes: pass 1 serves the lowest virtual clocks and
  advances each served variant by `quantum / weight` (weight fixed at 1 today);
  pass 2 fills any leftover batch slots in today's age order. Pass 2 makes the
  new command a strict superset of the old one, so it is work-conserving and can
  never serve fewer runs than today.
- Enqueue and nack register a variant into `:ckVtime` at the floor with `NX`, so
  a brand-new key is reachable from its first enqueue and cannot be parked behind
  a backlog. This is the case a per-key concurrency cap cannot fix: one tenant
  sharding work across many keys.
- Flag off is byte-identical: the pre-existing Lua scripts run unchanged and no
  vtime keys are created. The behaviour lives only in new command names.

Tuning knobs (real env var names, all positive integers, re-clamped in the
`RunQueue` constructor):

| Env var | Default | Meaning |
| --- | --- | --- |
| `RUN_ENGINE_CK_VTIME_SCHEDULING_ENABLED` | off | master flag |
| `RUN_ENGINE_CK_VTIME_QUANTUM` | 1 | virtual-time advance per serve |
| `RUN_ENGINE_CK_VTIME_WINDOW_MULTIPLIER` | 3 | pass-1 window = `maxCount * this` |
| `RUN_ENGINE_CK_VTIME_STATE_TTL_SECONDS` | 86400 | EXPIRE on the vtime keys |

Stated limitations this benchmark deliberately probes (from
`../../src/run-queue/CK_VTIME_KNOWN_LIMITATIONS.md`): bounded tombstone drift on
ack/TTL/DLQ paths; member-name tie-break at equal tags; future-scheduled or
retry-backoff variants occupying pass-1 window slots; and the pass-1 window being
narrower than the live variant cardinality.

## Validity: the numbers are RELATIVE, not absolute

The target is one node on nested/slow storage. Absolute throughput here is NOT
prod-scale and must never be reported as such. Every result is a ratio between
flag OFF and flag ON, measured under identical load on the same box in the same
session. That relative signal is what isolates the scheduler. Two guards keep the
arms comparable:

- Same enqueue set, same timestamps, same step loop / same load generator across
  OFF and ON.
- Fresh queue state between arms (the micro arm FLUSHes a dedicated Redis; the
  end-to-end arm drains and uses a fresh batch tag), a warmup, and N trials.

## Two arms

### Arm 1 (PRIMARY): queue-level micro-benchmark

Drives the real `RunQueue` directly against a dedicated Redis, comparing OFF vs
ON on identical synthetic load. This isolates the scheduler and is where the
defensible numbers come from. Because the flag is a `RunQueue` constructor
option, one bench process runs both arms in-process: no webapp, no redeploy, no
worker clusters. It reuses the existing fairness harness
(`../../src/run-queue/tests/ckVtimeFairness.test.ts`): same step loop, same
scenario shapes, same conservation checks, plus wall-clock latency, a Redis
op-count, N trials, and file output.

Harness: `../../src/run-queue/bench/ckMicroBench.bench.test.ts`. It is inert in CI
(only runs when `CK_BENCH_REDIS_URL` is set) and FLUSHes its target Redis between
arms, so it must point only at a dedicated throwaway instance.

Each step makes one `maxCount = 10` dequeue call, records `(step, key, messageId,
wallMs)` per served message, then acks in-flight messages whose logical hold has
elapsed. Wait per message = the step it was served at (all load is pre-enqueued
at step 0). The logical schedule is deterministic, so step-based metrics are
identical across trials (the harness asserts this); trials exist to stabilise the
wall-clock latency and op-count.

### Arm 2 (END-TO-END): deployed tasks on the worker clusters

The realism check on top of arm 1. A deployed task on a shared base queue with
per-run concurrency keys, driven by a noisy-neighbor load generator: tenant A
floods across many keys, tenant B sends a few. Each run carries a per-run region
so the load also spreads across the three managed worker groups
(`trigger-regiona/b/c`), exercising multi-cluster placement. Latency is read back
per run as `startedAt - createdAt`.

Project: `e2e-tasks/` (deployable, secret-free). Contention is forced by pinning
the environment concurrency ceiling low (so many keys contend for a few slots and
the CK dequeue order decides who starts first); the per-key lane width is 1 in the
task config for reproducibility.

Because the flag is server-side here, arm 2 is a manual OFF-then-ON: set the flag,
redeploy the control plane, run the load, collect; flip the flag, redeploy, run
the load again, collect. The exact toggle + redeploy belongs to the operator
runbook.

## Hypotheses (tied to the change)

1. **Bounded wait behind a backlog.** A light key arriving behind a big backlog
   waits O(number of active keys) under vtime, versus O(backlog size) under the
   baseline (which drains the backlog first). Micro: `ckSkew`, `ckTrickle`
   victim wait p95/p99 drops sharply ON vs OFF. E2E: tenant B start-latency p95
   stays bounded as tenant A's backlog grows.
2. **Sharding across many keys cannot starve others.** A tenant fanning out over
   many concurrency keys (the case a per-key cap cannot fix) does not starve a
   light key, because the light key registers at the floor and is reachable in
   pass 1. Micro: `ckSybil` victim first-serve step is small ON (near-immediate)
   and its wait ratio drops; `ckManyKeys` shows no permanent starvation even
   when cardinality exceeds the pass-1 window. E2E: tenant B (few keys) is not
   starved by tenant A's many-key flood.
3. **Work conservation.** A lone backlogged tenant still drains at full rate;
   the fair order adds no idle time when nothing else contends. Micro:
   `ckHeavyIdle` drain step ON equals OFF exactly. No-harm corollary: the
   symmetric `ckBalanced` case is not made worse.

## Scenarios

### Arm 1 (micro), all ported from the fairness-spike shapes

| scenario | shape | env limit | hold | probes |
| --- | --- | --- | --- | --- |
| `ckSkew` | heavy 120 backlog + 4 light x 10 | 1 | 3 | starvation (H1) |
| `ckTrickle` | bulk 120 + 2 trickle x 15 | 1 | 3 | starvation (H1) |
| `ckSybil` | 20 attacker x 8 + 1 light x 10 | 25 | 3 | sharding/sybil (H2) |
| `ckManyKeys` | 60 attacker x 8 (tied head) + 1 light x 10 | 25 | 3 | window limitation, no permanent starvation (H2) |
| `ckBalanced` | 4 symmetric x 25 | 4 | 3 | no-harm (H3) |
| `ckHeavyIdle` | 1 key x 60 | 25 | 3 | work conservation (H3) |

### Arm 2 (end-to-end), noisy-neighbor

- Tenant A: `A_KEYS` (default 40) keys x `A_PER_KEY` (default 5) runs = the flood.
- Tenant B: `B_KEYS` (default 2) keys x `B_PER_KEY` (default 5) runs = the victim.
- Per-run hold `HOLD_MS` (default 1500). Runs round-robined across the three
  regions. Environment concurrency ceiling pinned low (e.g. 5) so the keys
  actually contend.
- Optional placement variant: pin tenant A to one region and tenant B to another
  to separate scheduler effects from cross-cluster effects.

## Metrics and collection

| metric | what it shows | source |
| --- | --- | --- |
| victim wait p50/p95/p99 | starvation relief | micro: serve step; e2e: `startedAt - createdAt` per tenant |
| victim first-serve (starvation bound) | reachability at the floor | micro: first serve step for the victim key |
| drain step / total served | work conservation, no loss/dup | micro: last serve step + unique messageId count |
| Jain's fairness index | share fairness during contention | micro: over per-key contention-window serves |
| dequeue call p95 (ms) | scheduler op cost (relative) | micro: wall-clock around each dequeue call |
| redis ops (dequeue+ack) | per-dequeue overhead | micro: `CONFIG RESETSTAT` then `INFO commandstats` |

Jain's index over per-key served counts `x_i`: `J = (sum x_i)^2 / (n * sum
x_i^2)`. 1.0 is perfectly fair; `1/n` means one key took everything.

The micro harness writes `ck-micro-results.json` and `ck-micro-results.md`
(the results table below) to `CK_BENCH_OUT`.

For the end-to-end arm, the primary source is the Runs API by tag
(`startedAt - createdAt`), which `collect.ts` reads. Two alternatives give a
tighter dequeue-only timestamp if the API delta looks noisy:

- TRQL `runs` (verify column names with the query schema first): per-run
  `createdAt` and `startedAt`, filtered by the batch/arm tag.
- The run-engine Postgres `TaskRun` timestamps directly (createdAt and the first
  attempt/started timestamp), if API round-trips add too much jitter.

## Reproducible A/B procedure

### Arm 1 (micro)

1. Stand up a dedicated throwaway Redis reachable from the harness host (a local
   forward is fine). Nothing else may use it.
2. From the run-engine package:

   ```bash
   CK_BENCH_REDIS_URL=redis://127.0.0.1:6399 \
   CK_BENCH_TRIALS=5 CK_BENCH_OUT=./bench-results \
   pnpm exec vitest run src/run-queue/bench/ckMicroBench.bench.test.ts
   ```

   Both arms (OFF, then ON) run in one process per scenario, FLUSHing between
   arms. Knob sweep: add `CK_BENCH_QUANTUM` / `CK_BENCH_WINDOW_MULT`. Scenario
   subset: `CK_BENCH_SCENARIOS=ckSybil,ckSkew`.
3. Read `bench-results/ck-micro-results.md`. The harness fails the run if either
   arm loses or double-serves a message, so a green run means the comparison is
   sound.

### Arm 2 (end-to-end)

1. Deploy `e2e-tasks/` to the bench project's PROD environment (dev
   short-circuits worker-group routing, so it must be prod). Pin the prod env
   concurrency ceiling low.
2. Warmup: trigger a handful of runs, confirm they start on each region, discard.
3. **Arm OFF:** ensure the flag is off and the control plane is redeployed; then
   `ARM=off BATCH=<id1> pnpm loadgen`, wait for drain, `ARM=off BATCH=<id1> pnpm
   collect`.
4. **Arm ON:** flip the flag on, redeploy the control plane, drain/clear queue
   state; then `ARM=on BATCH=<id2> pnpm loadgen`, wait for drain, `ARM=on
   BATCH=<id2> pnpm collect`.
5. Repeat both arms N times with fresh batch ids; compare per-tenant latency.

The exact deploy, flag-toggle, and secret-key retrieval steps for the specific
box are in the operator runbook (kept out of this repo).

## Results template (paste into the PR)

Fill from `ck-micro-results.md` (arm 1) and `e2e-summary.md` (arm 2). Keep the
"relative only" caveat in the PR text.

### Arm 1 (micro), quantum 1 / window x3, N trials, dedicated Redis on the box

| scenario | metric | baseline (OFF) | vtime (ON) | delta |
| --- | --- | --- | --- | --- |
| **ckSkew** | victim wait p95 (steps) | | | |
| | victim wait p99 | | | |
| | victim first-serve | | | |
| | drain step | | | |
| | dequeue call p95 (ms) | | | |
| **ckTrickle** | victim wait p95 | | | |
| | victim first-serve | | | |
| **ckSybil** | victim wait p95 | | | |
| | victim first-serve | | | |
| | Jain index (contention) | | | |
| **ckManyKeys** | victim first-serve | | | |
| | drain step | | | |
| **ckBalanced** | worst-key wait p95 | | | |
| **ckHeavyIdle** | drain step | | | |
| (all) | redis ops (dequeue+ack) | | | |

### Arm 2 (end-to-end), noisy-neighbor across regiona/b/c, env cap N

| tenant | metric | baseline (OFF) | vtime (ON) | delta |
| --- | --- | --- | --- | --- |
| B (victim, few keys) | start latency p50 (ms) | | | |
| B | start latency p95 | | | |
| B | start latency p99 | | | |
| A (flood, many keys) | start latency p95 | | | |

Expected direction: B's p95/p99 drop substantially ON; A's is similar or slightly
higher ON (it stops jumping the queue); `ckHeavyIdle` drain step is exactly equal;
`ckBalanced` worst-key wait is within noise.

## How to reproduce on the box (short)

1. Dedicated Redis up, forwarded locally. Run the arm-1 vitest command above;
   collect `ck-micro-results.md`.
2. Deploy `e2e-tasks/` to prod, pin the env concurrency ceiling, warm up.
3. Flag OFF: redeploy control plane, loadgen + collect. Flag ON: redeploy,
   loadgen + collect. N trials.
4. Paste both tables into the PR under a "relative numbers on a single
   prod-shaped box" heading.
