# Fair-queueing spike: findings

Findings from a throwaway spike whose harness is archived and ships nothing; these
findings are retained here as a design reference that informed the change, not as code.

Read the caveats section before quoting any single number. Two of them matter up
front: (1) the candidate selectors are handed tenant identity (parsed from the
queue name) and the exact per-tenant weights, and the fairness target is defined
by those same groups and weights, so the candidate win over the tenant-blind
baseline is closer to definitional than discovered. (2) The harness anchors
message scores far in the past, which flattens all queue ages, so the baseline's
production age bias is not exercised here; the baseline measured is closer to a
uniform-random shuffle than the real one.

Bottom line: at the base-queue grain, virtual-time ordering (SFQ) and stride give
tight, seed-stable proportional fairness, honour weights, and cut a starved
tenant's wait hard. DRR lands within noise of them (its small shortfall is a
measurement artifact of the harness, not an intrinsic property). The baseline is
fair on average but seed-variant and has no weight concept. The CoDel wrapper is
not worth shipping as built: it is a forced no-op under bulk arrival and it
actively hurt fairness on the one trickle-arrival workload that could exercise it.
The biggest single result is architectural: per-concurrency-key fairness (the
actual #2617 grain) cannot be expressed through the `RunQueueSelectionStrategy`
interface at all; it lives below that interface, in the CK-dequeue Lua.

Every number comes from the real `RunQueue` against a testcontainers Redis, one
selector per run, real enqueue/dequeue/ack and real concurrency gating. Each
scenario runs over 3 seeds; tables show the mean and min..max spread. Per-tenant
detail (first seed) is in `results/*.json`.

## Grain, and why it is not the concurrency key

A tenant is the fairness group; a tenant owns one or more base queues. The
adversarial scenario gives one tenant 30 queues and the light tenants one each,
which is how the #2617 starvation shows up at the base-queue grain: an ordering
blind to tenant identity lets the many-queue tenant win most of the selection
chances.

The concurrency-key grain #2617 asks for is not reachable through the strategy
interface. `FairQueueSelectionStrategy` reads the master-queue members verbatim,
and CK runs enqueue a single CK-wildcard entry per base queue. The per-CK pick
runs later inside `dequeueMessagesFromCkQueueTracked`, where `ckIndexKey` is a
ZSET of CK-queues scored by head timestamp and the Lua serves them oldest-first.
That age ordering is the unfairness. Fixing it means changing that Lua or the
`ckIndex` scoring, not the selection strategy. That is the follow-on spike.

## How fairness is measured (and its limits)

Because the sim drains every run, final throughput share is fixed by the workload
and cannot tell selectors apart. Two measures do:

- contention share: a tenant's share of dequeues at instants when at least two
  tenants have arrived, unserved work, over its expected weighted share.
  `contWorstS/W` is the least-served contender; 1.0 is fair, near 0 means starved
  while others had work. Getting this right took two corrections a review caught:
  it must only count a tenant once its runs have actually arrived (else poisson
  arrival looks like starvation), and the virtual-time floor must be monotonic
  (else a returning idle tenant monopolises and skews the window). Even so, when
  tenants have very different volumes (trickleStale: 30 runs vs 300) the
  low-volume tenant can legitimately be over- or under-represented in the window,
  so read this metric together with wait, not alone.
- wait: dequeue time minus enqueue time, per tenant, in the JSON. This is the
  clean anti-staleness signal. (Note: `worstWaitP99` in the JSON is NOT an
  anti-staleness win signal; it is dominated by the highest-volume tenant, which
  a fair selector deliberately delays, so a fairer selector scores worse on it.
  Use per-tenant wait.)

## Results

`contWorstS/W` mean over 3 seeds (min..max). Higher is fairer.

| scenario        | baseline            | sfq   | drr                 | stride | codel-sfq | codel-baseline |
| --------------- | ------------------- | ----- | ------------------- | ------ | --------- | -------------- |
| balanced        | 0.889 (0.774..0.954)| 0.985 | 0.954 (0.923..0.970)| 0.985  | 0.985     | 0.889          |
| adversarialSkew | 0.288 (0.261..0.310)| 1.000 | 0.978 (0.968..0.984)| 1.000  | 1.000     | 0.288          |
| weighted        | 0.703 (0.679..0.719)| 1.000 | 0.990 (0.977..1.000)| 1.000  | 1.000     | 0.703          |
| burst           | 0.978 (0.966..0.992)| 0.992 | 0.958 (0.941..0.975)| 0.992  | 0.992     | 0.978          |
| longHold        | 0.828 (0.800..0.842)| 0.981 | 0.981               | 0.981  | 0.981     | 0.828          |
| trickleStale    | 0.208 (0.179..0.235)| 0.804 (0.769..0.826)| 0.776 (0.769..0.783)| 0.804 | 0.366 | 0.195 |

Per-tenant mean wait (seed-a, logical ms), the anti-staleness signal:

| scenario / selector      | low-volume tenant wait | heavy tenant wait |
| ------------------------ | ---------------------- | ----------------- |
| adversarialSkew baseline | 1380                   | 805               |
| adversarialSkew sfq      | 319                    | 1324              |
| trickleStale baseline    | 1359                   | 1234              |
| trickleStale sfq         | 19                     | 1353              |
| trickleStale codel-sfq   | 213                    | 1315              |

Reading these: the fair selectors cut the light tenant's wait (skew 1380 to 319,
trickle 1359 to 19) by making the heavy tenant wait its fair turn. The heavy
tenant is not punished, it stops jumping the queue. CoDel undoes part of the
trickle win (19 back up to 213).

## Verdict per mechanism

- SFQ (start-time virtual time, the start-tag form of WFQ): the strongest result.
  Perfect contention fairness under skew and weighting, seed-stable (zero variance
  across seeds), and the largest cut to the starved tenant's wait. The floor is
  now monotonic (a review found the earlier version let a returning idle tenant
  monopolise; fixed). Recommended as the leaf ordering.
- Stride: identical to SFQ to the decimal on every scenario. The spike does not
  separate them. Stride carries slightly less state.
- DRR: within noise of SFQ. It trails by a couple of points on balanced (0.954)
  and burst (0.958) and matches SFQ elsewhere. That small shortfall is a
  measurement artifact, not an intrinsic property: the driver drains a whole
  capacity batch from a single strategy snapshot and only advances DRR's deficit
  after the batch (via `onServiced`), so DRR's current-winner group, whose queues
  it fronts together, grabs several slots before its deficit updates and its
  deficit runs negative. Served one-at-a-time DRR is exactly fair (see
  `drr.test.ts`). Note the earlier claim that "virtual-time sorts an over-served
  group's queues to the back and so avoids this" was wrong: at a tie all of a
  group's queues share one clock, so SFQ fronts them together too; the schemes
  only separate after their state advances. DRR is O(1) and composes weight
  trivially, so it is a fine choice if per-op cost matters, subject to that
  caveat.
- CoDel wrapper: do not ship as built. Under bulk arrival it is a forced no-op:
  all of a queue's runs share one enqueue timestamp, so every tenant's sojourn is
  identical and they all cross the target together, so hoisting everyone collapses
  to the base order (this is why codel-sfq equals sfq and codel-baseline equals
  baseline to the decimal on those scenarios; it is one workload shape confirming
  a null result, not five independent tests). On trickleStale, the one scenario
  where sojourns diverge, the sojourn-hoist overshoots: it drops SFQ from 0.804 to
  0.366 and pushes the trickle tenant's wait from 19 back to 213. A staleness
  monitor may still help on top of an unfair base or behind a hard concurrency
  wall, but that needs a different construction and this spike does not support it.
- Baseline (`FairQueueSelectionStrategy`): fair on average on the easy scenarios
  but seed-variant (balanced 0.774..0.954), no weight concept (weighted 0.703),
  and it starves a light tenant under queue-count skew (0.288) and under trickle
  arrival (0.208, trickle wait 1359). Remember its age bias is not exercised here
  (see caveats), so this is a floor on its unfairness, not the production picture.

## Caveats

- Grain is base queues, not concurrency keys. The disciplines are grain-agnostic
  so the ranking should carry over, but the #2617 gap itself needs the CK-Lua
  spike. adversarialSkew is a proxy for that gap, not a measurement of it.
- Definitional advantage: candidates get tenant identity and exact weights the
  real interface does not carry; the baseline structurally cannot.
- Baseline age bias inert: scores are anchored ~600s in the past, so all queue
  ages are near-equal and the baseline degenerates to near-uniform selection. The
  production age bias (which would give a heavy tenant's older heads more weight,
  i.e. make skew worse) is not measured.
- Selection-only seam: the driver feeds serviced descriptors back via an
  `onServiced` hook; production would advance selector state inside the ack/dequeue
  Lua. The spike proves ordering logic, not that wiring.
- Cost was not rigorously measured. `selectionRounds` is roughly equal across
  selectors (646..729) but is not comparable between them (a candidate reads all
  queues per call; the baseline short-circuits at capacity), and there is no load
  benchmark. DRR's "O(1)" advantage is a theory claim, not a spike measurement.
- Scenario quality varies. balanced best shows the baseline's variance;
  adversarialSkew and weighted carry the clear separation; longHold and burst
  barely separate the candidates; trickleStale's contention number only became
  meaningful after two metric fixes and should be read with wait. Per-tenant p99
  equals max for the small (20 to 30 run) tenants, so "p99" there is just the max.
- Single Redis shard; single sequential consumer (not the multi-consumer,
  Redis-hash-state design the spec sketched); simulated holds on a logical clock.
  Three seeds shows the baseline's variance and the virtual-time schemes'
  stability but is not a statistical study.

## Recommended direction

Use virtual-time (SFQ, or stride) for leaf ordering and compose weight with it.
DRR is an acceptable O(1) fallback given the batch caveat. Do not adopt the CoDel
wrapper as built. Then run the follow-on spike against the CK-dequeue Lua /
`ckIndex` scoring, because that is where per-tenant fairness actually has to land
in the current design.
