# Fair-queueing spike: findings

Bottom line: at the base-queue grain, virtual-time ordering (SFQ) and stride both
give provable-in-practice proportional fairness and fix tenant starvation
outright. DRR gets within a couple of percent. The CoDel wrapper does no harm and
sits ready as a staleness safety net, but the workloads here never pushed it to
do much. The single biggest thing the spike turned up is architectural, not a
ranking: per-concurrency-key fairness (the actual #2617 grain) cannot be
expressed through the `RunQueueSelectionStrategy` interface at all. It lives below
that interface, in the CK-dequeue Lua.

All numbers come from the real `RunQueue` running against a testcontainers Redis,
one selector swapped in per run, real enqueue/dequeue/ack and real concurrency
gating. See `results/*.json` for the full per-tenant detail.

## What the grain is, and why

A "tenant" is the fairness group. Each tenant owns one or more base queues. The
adversarial scenario gives one tenant 50 queues and the light tenants one each,
which is how the #2617 starvation shows up at the base-queue grain: any ordering
that is blind to tenant identity (the current baseline) lets the 50-queue tenant
win roughly 50/55 of the selection chances, so the light tenants wait.

The concurrency-key grain that #2617 literally asks for is not reachable here.
`FairQueueSelectionStrategy` reads the master-queue members verbatim, and
CK runs enqueue a single CK-wildcard entry per base queue. The per-CK pick runs
later, inside `dequeueMessagesFromCkQueueTracked`, where `ckIndexKey` is a ZSET of
CK-queues scored by head-message timestamp and the Lua serves them oldest-first.
That age ordering is the unfairness. Fixing it means changing that Lua or the
`ckIndex` scoring, not the selection strategy. That follow-on is its own spike.

## How fairness is measured

Because the sim drains every run, final throughput share is fixed by the workload
(every tenant's runs all complete eventually), so it is the same for every
selector and tells you nothing. Two measures that do discriminate:

- contention share: each tenant's share of dequeues during the window while at
  least two tenants still have work, divided by its expected weighted share. 1.0
  is fair, values near 0 mean that tenant was starved while others had work.
  `contWorstS/W` is the least-served tenant.
- wait: dequeue time minus enqueue time, per tenant. The scenario-level
  `worstWaitP99` is dominated by the highest-demand tenant (which correctly waits
  longer under fair sharing), so the useful wait signal is per-tenant, in the
  JSON.

## Results

`contWorstS/W` and `contJain` (Jain index over contending tenants), higher is
fairer:

| scenario        | baseline | sfq   | drr   | stride | codel-sfq |
| --------------- | -------- | ----- | ----- | ------ | --------- |
| balanced        | 0.923    | 0.985 | 0.970 | 0.985  | 0.985     |
| adversarialSkew | 0.141    | 1.000 | 0.976 | 1.000  | 1.000     |
| weighted        | 0.714    | 1.000 | 0.983 | 1.000  | 1.000     |
| burst           | 0.992    | 0.992 | 0.983 | 0.992  | 0.992     |
| longHold        | 0.962    | 0.981 | 0.943 | 0.981  | 0.981     |

The adversarialSkew row is the headline. Baseline gives the light tenants 0.141 of
their fair share during contention (Jain 0.234). SFQ, stride and CoDel-wrapped-SFQ
give 1.000 (Jain 1.000). DRR gives 0.976.

Per-tenant wait under adversarialSkew, in logical ms:

| selector  | light mean wait | light p99 | heavy mean wait |
| --------- | --------------- | --------- | --------------- |
| baseline  | 2452            | 3646      | 1658            |
| sfq       | 309             | 662       | 2103            |
| drr       | 310             | 688       | 2102            |
| stride    | 309             | 662       | 2103            |
| codel-sfq | 309             | 662       | 2103            |

So the disciplines cut the light tenant's wait by about 8x (2452 to 309) by making
the heavy tenant wait its fair turn (1658 up to 2103). The heavy tenant is not
punished, it just stops jumping the queue.

The weighted scenario is the other clear separation: baseline has no weight
concept, so the small tenant only reaches 0.714 of its weighted share, while the
virtual-time schemes track the 3:1 split exactly.

burst and longHold show little to separate the selectors: there is no
tenant-multiplication in those, so the baseline's per-queue ordering is already
close to fair.

## Verdict per mechanism

- SFQ (start-time virtual time): proven. Perfect contention fairness under both
  skew and weighting, and the largest cut to light-tenant wait. One number per
  group plus a floor. Recommended as the leaf ordering.
- Stride: proven, and indistinguishable from SFQ on every scenario here (both are
  integer virtual-time proportional share). Slightly simpler state (a single pass
  counter per group, no floor bookkeeping). A fine substitute for SFQ.
- DRR: proven, with a caveat. It lands at 0.976 and 0.983 where SFQ/stride hit
  1.000, and it is the only selector to dip below baseline on one scenario
  (longHold, 0.943 vs 0.962). That matches theory: round-granularity gives a
  looser bound than virtual time. It is O(1) and composes weight trivially, so it
  is the pick if per-op cost ever dominates.
- CoDel wrapper: no regressions, matches its SFQ base everywhere. It never changed
  an outcome because none of these workloads build a sustained sojourn violation
  that fair ordering does not already prevent. Its value is a tail-latency safety
  net for conditions this spike did not stress (a genuinely stuck tenant behind a
  hard concurrency wall), so keep it as an optional companion, not a primary
  selector.

## Caveats (read before quoting any number)

- Grain is base queues, not concurrency keys. The disciplines are grain-agnostic,
  so the ranking should carry over, but the exact #2617 gap needs the CK-Lua
  spike to confirm.
- The strategy interface is selection-only, so the driver feeds serviced
  descriptors back via an `onServiced` hook. In production that state (virtual
  clock, deficit, pass counter) would advance inside the ack/dequeue Lua. The
  spike proves the ordering logic, not that Lua wiring.
- Single Redis shard. Global fairness across many shards and pull-based consumers
  is a separate problem and is not tested here.
- Hold durations are simulated, and the clock is logical. Wall-clock cost is in
  the JSON (`wallClockMs`) but is not a load benchmark.

## Recommended direction

Use virtual-time (SFQ, or stride if you prefer the simpler counter) for leaf
ordering, compose weight with it, and keep a CoDel-style sojourn monitor as an
optional safety net. Reach for DRR only if profiling later shows virtual-clock
maintenance is too expensive. Then run the follow-on spike against the CK-dequeue
Lua / `ckIndex` scoring, because that is where per-tenant fairness actually has to
land in the current design.
