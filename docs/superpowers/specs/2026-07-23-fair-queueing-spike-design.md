# Fair-queueing scheduler spike: design

## What this is

A throwaway spike to rank fair-queueing methods for the Run Engine 2.0 RunQueue
against each other, so we can decide which one (if any) is worth taking further.
It ships nothing. The output is a ranking table plus a short findings writeup.

Background: the current RunQueue does environment-level fairness via
`FairQueueSelectionStrategy`, but has no per-tenant/per-group fairness below the
environment (GitHub #2617). A `concurrencyKey` spawns a separate queue and a
separate limit per key, so one tenant firing 1000 tasks can occupy a whole
environment while other tenants wait. The design brief (`compass_artifact`)
proposes four methods: SFQ virtual-time tagging, hierarchical DRR, a CoDel-style
staleness monitor, and stride/lottery as a baseline. This spike puts those four
on trial next to the existing strategy.

## Goal

Rank five selectors: the four candidates plus the current
`FairQueueSelectionStrategy` as baseline. Ranking only, no absolute pass/fail
bar. Three axes:

- fairness: per-group throughput share divided by configured weight, plus a Jain
  index and the worst-served group.
- anti-staleness: per-group dequeue wait (dequeue time minus enqueue time), p50,
  p99, max. Under skew the light tenant's p99 is the headline number.
- cost: wall-clock and Redis op count per dequeue, rough.

## Harness (Approach 1: full RunQueue driver)

Stand up the real `RunQueue` against a testcontainers Redis. Swap
`queueSelectionStrategy` per candidate. A synthetic load generator enqueues runs
across N groups at configurable rates. A pool of fake workers dequeues, holds a
concurrency slot for a sampled duration, then acks. The driver records every
dequeue event and computes the metrics.

This is faithful because the concurrency consume-then-release feedback loop that
drives `availableCapacityBias` is the real one, not a simulation.

Fairness grain is the `concurrencyKey`/groupId, expressed as ordering among the
sibling queue keys that come back in `EnvQueues.queues`.

### The selection-only seam

The `RunQueueSelectionStrategy` interface is invoked at selection and is never
told which queue actually got dequeued. So a virtual clock, a deficit counter, or
a pass counter has nothing to advance on. In production that state would advance
inside the ack/dequeue Lua. For the spike, the driver sees each dequeued message
(org, queue, concurrencyKey) and feeds it back via an optional
`onServiced(descriptor)` hook on the candidate. This is a spike-only affordance
and a fidelity caveat: it proves the ordering logic, it does not prove the
production Lua wiring.

## Components

- `strategies/sfqStrategy.ts`: per-group virtual clock in a Redis hash, start tag
  = max(group vclock, system vclock floor), order by smallest eligible tag,
  EEVDF-style eligibility guard. Advances the vclock on `onServiced`.
- `strategies/drrStrategy.ts`: per-group deficit and quantum (weight),
  round-robin scan of active groups. Advances the deficit on `onServiced`.
- `strategies/strideStrategy.ts`: stride = big/weight, pass counter, pick lowest
  pass, advance by stride. Integer virtual-time baseline.
- `strategies/codelWrapper.ts`: wraps a base selector. Tracks per-group minimum
  sojourn (now minus head enqueue score) over an interval; when it stays above
  target, escalates that group's effective weight/priority. Not a standalone
  selector.
- baseline: the existing `FairQueueSelectionStrategy`, imported unchanged.
- `harness/workload.ts`: seeded generator. Group set, arrival rates, service-time
  sampler, weights.
- `harness/driver.ts`: runs `RunQueue` plus the fake worker pool, records dequeue
  events, calls `onServiced`.
- `harness/metrics.ts`: share-vs-weight, Jain index, wait percentiles, cost.
- `harness/scenarios.ts`: named scenarios.
- `fairnessSpike.bench.test.ts`: runs the matrix (5 selectors x scenarios) and
  prints the ranking table.
- `FINDINGS.md`: written up at the end.

## Scenarios (all seeded, deterministic)

- balanced: equal groups, equal weight. Sanity check: shares should come out
  equal.
- adversarial skew: one heavy group with 1000 runs versus many light groups with
  10 each, equal weight. Does the light group starve?
- weighted: 3:1 configured weights. Does share track weight?
- burst: idle, then a thundering enqueue.
- long-hold: some groups hold concurrency slots far longer than others. Tests
  that dequeue fairness stays separate from concurrency occupancy (the brief's
  30-day-run point).

## Out of scope

- No changes to the production enqueue/dequeue/ack Lua. Candidates advance their
  state via the harness `onServiced` hook.
- Single Redis shard only. Global multi-shard fairness is a known gap, noted
  rather than solved.
- Simulated hold durations, not real long-running runs.
- No webapp wiring.

## Deliverable

The ranking table from the bench test, plus `FINDINGS.md` with a
proven/disproven-ish verdict per method and a recommendation on what (if
anything) to take past the spike.
