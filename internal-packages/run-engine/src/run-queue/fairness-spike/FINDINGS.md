# Fair-queueing spike: findings

Bottom line: at the base-queue grain, virtual-time ordering (SFQ) and stride give
tight, seed-stable proportional fairness and fix tenant starvation. DRR lands
within noise of them. The current baseline is fair on average but seed-variant,
has no weight concept, and starves a light tenant whenever a heavy tenant
multiplies its queues. The CoDel wrapper, as built here, is not a free safety net:
it is a forced no-op on bulk-arrival workloads and it slightly hurt fairness on
the one trickle-arrival workload that could exercise it. The single biggest thing
the spike turned up is architectural: per-concurrency-key fairness (the actual
#2617 grain) cannot be expressed through the `RunQueueSelectionStrategy` interface
at all. It lives below that interface, in the CK-dequeue Lua.

Every number comes from the real `RunQueue` running against a testcontainers
Redis, one selector swapped in per run, real enqueue/dequeue/ack and real
concurrency gating. Each scenario is run over 3 seeds; the tables show the mean
and the min..max spread. Full per-tenant detail is in `results/*.json`.

## What the grain is, and why

A "tenant" is the fairness group. Each tenant owns one or more base queues. The
adversarial scenario gives one tenant 30 queues and the light tenants one each,
which is how the #2617 starvation shows up at the base-queue grain: any ordering
blind to tenant identity (the baseline) lets the many-queue tenant win roughly
30/35 of the selection chances, so the light tenants wait.

The concurrency-key grain that #2617 literally asks for is not reachable here.
`FairQueueSelectionStrategy` reads the master-queue members verbatim, and CK runs
enqueue a single CK-wildcard entry per base queue. The per-CK pick runs later,
inside `dequeueMessagesFromCkQueueTracked`, where `ckIndexKey` is a ZSET of
CK-queues scored by head-message timestamp and the Lua serves them oldest-first.
That age ordering is the unfairness. Fixing it means changing that Lua or the
`ckIndex` scoring, not the selection strategy. That follow-on is its own spike.

## How fairness is measured

Because the sim drains every run, final throughput share is fixed by the workload
and is the same for every selector, so it tells you nothing. Two measures do
discriminate:

- contention share: each tenant's share of dequeues during the window while at
  least two tenants still have work, over its expected weighted share. 1.0 is
  fair, values near 0 mean that tenant was starved while others had work.
  `contWorstS/W` is the least-served contender.
- wait: dequeue time minus enqueue time, per tenant, in the JSON.

One caveat on contention share, learned from the trickle scenario: when a fair
selector correctly lets a low-volume tenant go first, the high-volume tenant
becomes the least-served contender by design, so `contWorstS/W` can read low
(around 0.39) even though nobody is starved. Read it together with per-tenant
wait, which is unambiguous. Jain is reported per scenario only (its floor is 1/n,
so values are not comparable across scenarios with different tenant counts). The
"expected share" denominator is the weight sum over all tenants that contended in
the window, held fixed for the window (a simplification, not time-varying).

## Results

`contWorstS/W` mean over 3 seeds, with min..max. Higher is fairer.

| scenario        | baseline            | sfq   | drr                 | stride | codel-sfq | codel-baseline |
| --------------- | ------------------- | ----- | ------------------- | ------ | --------- | -------------- |
| balanced        | 0.889 (0.774..0.954)| 0.985 | 0.954 (0.923..0.970)| 0.985  | 0.985     | 0.889          |
| adversarialSkew | 0.288 (0.261..0.310)| 1.000 | 0.978 (0.968..0.984)| 1.000  | 1.000     | 0.288          |
| weighted        | 0.703 (0.679..0.719)| 1.000 | 0.990 (0.977..1.000)| 1.000  | 1.000     | 0.703          |
| burst           | 0.978 (0.966..0.992)| 0.992 | 0.958 (0.941..0.975)| 0.992  | 0.992     | 0.978          |
| longHold        | 0.828 (0.800..0.842)| 0.981 | 0.981               | 0.981  | 0.981     | 0.828          |
| trickleStale    | 0.208 (0.179..0.235)| 0.390 | 0.388 (0.361..0.421)| 0.390  | 0.337     | 0.195          |

Per-tenant wait (seed-a, logical ms), the anti-staleness signal:

| scenario / selector       | light/trickle mean wait | light/trickle p99 | heavy mean wait |
| ------------------------- | ----------------------- | ----------------- | --------------- |
| adversarialSkew baseline  | 1380                    | 1989              | 805             |
| adversarialSkew sfq       | 319                     | 710               | 1324            |
| trickleStale baseline     | 1359                    | 1845              | 1234            |
| trickleStale sfq          | 10                      | 40                | 1359            |
| trickleStale codel-sfq    | 208                     | 328               | 1319            |

## Verdict per mechanism

- SFQ (start-time virtual time): the strongest result. Perfect contention
  fairness under skew and weighting, seed-stable (zero variance across seeds),
  and it cuts the light tenant's wait hard (skew 1380 to 319, trickle 1359 to 10).
  Recommended as the leaf ordering.
- Stride: identical to SFQ in every scenario tried, to the decimal. The spike did
  not build a case that separates them (the difference between them is in
  handling a group that goes idle then returns, and the poisson scenario here did
  not stress that cleanly). Treat them as equivalent for now; stride carries
  slightly less state (a single pass counter, no floor bookkeeping).
- DRR: within noise of SFQ. It trails by a couple of points on some scenarios
  (balanced 0.954, burst 0.958) and matches SFQ on others (longHold, adversarial
  near 0.98). An earlier single-seed run showed DRR dipping below baseline on
  longHold; that did not survive multiple seeds, so it was a sampling artifact,
  not a real effect. DRR is O(1) and composes weight trivially, so it is a fine
  choice if per-op cost ever matters. Note one measurement wrinkle: because the
  driver drains a batch of capacity from a single strategy snapshot, DRR (which
  fronts all of the current winner group's queues together) can grab several
  slots per snapshot before its deficit updates, which flatters the heavy tenant
  a little. The virtual-time schemes avoid this because they always sort an
  over-served group's queues to the back.
- CoDel wrapper: does not earn its place as built. On every bulk-arrival scenario
  it is a forced no-op: all of a queue's runs share one enqueue timestamp, so
  every tenant's sojourn is identical and grows together, so once the target is
  passed CoDel escalates every tenant at once and the order collapses back to the
  base order (this is why codel-sfq equals sfq, and codel-baseline equals
  baseline, to the decimal, on those scenarios). On trickleStale, the one scenario
  where sojourns actually diverge, CoDel made SFQ slightly worse (0.337 vs 0.390)
  and pushed the trickle tenants' wait up from 10 to 208 by over-hoisting. So the
  sojourn-hoist overshoots on top of an already-fair base. A staleness monitor may
  still be worth it on top of an unfair base or behind a hard concurrency wall,
  but that needs a different construction and tuning than this wrapper, and this
  spike does not support shipping it.
- Baseline (current FairQueueSelectionStrategy): fair on average on the easy
  scenarios but seed-variant (balanced ranges 0.774 to 0.954), no weight concept
  (weighted 0.703), and it starves a light tenant hard under queue-count skew
  (0.288) and under trickle arrival (0.208, trickle wait 1359).

## Caveats (read before quoting any number)

- Grain is base queues, not concurrency keys. The disciplines are grain-agnostic,
  so the ranking should carry over, but the exact #2617 gap needs the CK-Lua
  spike to confirm. The adversarialSkew number is a proxy for that gap, not a
  measurement of it.
- The strategy interface is selection-only, so the driver feeds serviced
  descriptors back via an `onServiced` hook. In production that state (virtual
  clock, deficit, pass counter) would advance inside the ack/dequeue Lua. The
  spike proves the ordering logic, not that Lua wiring.
- The candidates recover tenant identity from the queue name and are handed the
  exact per-tenant weights, and the fairness target is defined by those same
  groups and weights. So the candidate win over the tenant-blind baseline is
  closer to definitional than discovered. The real interface does not carry the
  tenant label the candidates rely on.
- Single Redis shard. Global fairness across many shards and pull-based consumers
  is a separate problem and is not tested here.
- Hold durations are simulated and the clock is logical. `wallClockMs` is in the
  JSON but is not a load benchmark. Three seeds is enough to show the baseline's
  variance and the virtual-time schemes' stability, but it is not a statistical
  study.

## Recommended direction

Use virtual-time (SFQ, or stride if you prefer the simpler counter) for leaf
ordering and compose weight with it. DRR is an acceptable O(1) fallback. Do not
adopt the CoDel wrapper as built. Then run the follow-on spike against the
CK-dequeue Lua / `ckIndex` scoring, because that is where per-tenant fairness
actually has to land in the current design.
