# Caps vs scheduling: reconciling the fairness spike with the plan of record

Throwaway spike design. Ships nothing; delete before any merge to main.

## Why

Two prior spikes (base-queue grain, then the real CK-dequeue grain) concluded:
score `ckIndex` by a fair discipline (SFQ/stride virtual time, or DRR) instead of
by head timestamp, to fix per-concurrency-key starvation (#2617). That is a
change to the fair-selection SCORING / serve order.

The plan of record for "Queue multi-tenant fairness" does something different. It
ships bounded concurrency CAP primitives and deliberately leaves the
fair-selection scoring untouched:

- Phase 1: a per-base-queue TOTAL concurrency cap (`:groupConcurrency` SET SCARD
  gated against a `:totalConcurrency` limit).
- Phase 2: a per-KEY concurrency limit (`:ckLimits` HASH, HGET per CK variant).

The only scheduler-adjacent change is negative: the fair-selection strategy drops
base queues already at their total cap so it stops picking them. Scoring within
the contended region is still head-timestamp order.

So the spiked mechanism (scheduling) and the shipped mechanism (caps) are
different knobs. This spike proves or disproves whether the caps deliver the
fairness the scheduling disciplines deliver, and reconciles the two.

## The thesis to test

From the research (see `RESEARCH.md`): occupancy caps and fair scheduling are
orthogonal. A cap bounds a tenant's occupancy and (via Little's Law) its
throughput share; it does not bound wait unless the dequeue is
oldest-ELIGIBLE-first AND freed slots exist. A scheduler bounds a starved
tenant's first-serve wait but is work-conserving (bounds no occupancy). Neither
substitutes for the other; production systems layer them (Kubernetes APF: seats +
fair queueing).

Falsifiable claims:

1. On a simple skew (one heavy key, light keys), a per-key cap on the heavy key
   cuts the light keys' wait about as well as SFQ, BECAUSE Trigger's CK dequeue is
   eligibility-aware (a variant at its per-key limit is skipped). Predict:
   per-key cap ~= SFQ on light-key wait here.
2. A per-key cap is NOT work-conserving: when the heavy key is alone (siblings
   idle), the cap throttles it below the env limit and idles slots, inflating
   makespan. SFQ/baseline uses the whole env. Predict: per-key cap makespan >>
   SFQ makespan on a heavy-alone workload.
3. A per-key cap fails the sybil split: a heavy tenant spreading its backlog over
   many CK variants, each under its per-key cap, still starves a late light key
   under oldest-first, because sum of per-key caps is unbounded relative to the
   queue. Predict: per-key cap light-key wait stays high on the sybil scenario;
   SFQ still protects the light key.
4. A total cap (per-task) does NOT fix cross-key starvation within one task: it
   lowers the whole task's ceiling uniformly, and age-order still serves the heavy
   backlog first within it. Predict: total-cap-only light-key wait ~= baseline.
5. Layered per-key cap + SFQ ordering (the APF pattern) is at least as good as
   either alone on every scenario. Predict: layered ~= SFQ on wait, and inherits
   the cap's occupancy bound.

## Harness

Reuse the CK harness (`fairness-spike-ck`) that drives the real
`dequeueMessagesFromCkQueueTracked` Lua at `maxCount = 1`, rescoring `ckIndex` to
express a discipline's order. Model the caps as admission gates:

- Per-key cap: a discipline marks any CK variant whose in-flight >= its per-key
  cap as INELIGIBLE. The driver writes ineligible variants a beyond-window
  `ckIndex` score so the real Lua's `ZRANGEBYSCORE -inf now` skips them, exactly
  as the real per-key gate would. Among eligible variants, keep baseline age
  order (or an inner scheduler for the layered discipline).
- Total cap: the driver refuses to dequeue when total in-flight (holding.length,
  = group SCARD for one base queue) >= the total cap, modelling the group gate.

This is faithful to the plan's eligibility-aware semantics; the fidelity gap is
the same `maxCount = 1` one the CK spike already documents (production dequeues in
batches; a real per-key/total gate lives inside the batched Lua).

New driver state: `inFlightByCk` and `runToCk`, maintained on serve/ack.

## Disciplines

- `baseline` (existing): age order, no cap.
- `perKeyCap(capOf)`: eligibility by per-key in-flight cap; age order among
  eligible. Heavy key capped low, others uncapped (env-bounded).
- `totalCap(n)`: no per-key differentiation, no rescore ordering change; driver
  gate on total in-flight. Models Phase 1 within one task.
- `sfq`, `stride`, `drr` (existing): scheduling.
- `perKeyCap+sfq` (layered): eligibility by per-key cap, SFQ order among eligible.
- (CoDel already disproven in the CK spike; not re-run here.)

## Scenarios

Existing: `ckSkew`, `ckBalanced`, `ckTrickle`. New:

- `ckSybil`: heavy tenant as MANY CK variants (~20), each a modest backlog, all
  enqueued early (old heads); one light key arrives later via poisson. Tests the
  sybil split.
- `ckHeavyIdle`: one heavy key with a large backlog, siblings absent or arriving
  very late and few. Tests work-conservation (makespan / idle slots).

## Metrics

Reuse `computeMetrics` (per-key wait = headline, contention share = directional).
Add `makespanMs` (max dequeue logical time) as the work-conservation signal:
a non-work-conserving cap inflates makespan on `ckHeavyIdle`.

## Success bar

Relative ranking only (as with the prior spikes), multi-seed, driving the real
Lua. The deliverable is a reconciliation verdict: which knob each mechanism is,
what each fixes and fails, and whether the plan's caps + the spike's scheduling
should layer.

## Not building

- A production implementation (spike is throwaway).
- A separate multi-base-queue (cross-task) harness for the total cap's real job
  (protecting one task's env budget from another task). The total cap's cross-task
  isolation is argued analytically from the research; within-task it is shown not
  to fix cross-key starvation. A cross-task harness is noted as future work.
- Re-running CoDel (already disproven at both grains).
