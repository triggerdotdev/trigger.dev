# Per-concurrency-key fairness spike: design

## What this is

The follow-on to the base-queue-grain fair-queueing spike. That spike found the
#2617 gap lives below the `RunQueueSelectionStrategy` interface, in the
CK-dequeue Lua: `dequeueMessagesFromCkQueueTracked` picks concurrency-key queues
from `ckIndexKey` oldest-head-first, so a concurrency key with a big backlog
starves other keys under the same base queue. This spike proves or disproves
whether the same disciplines (SFQ, DRR, stride, CoDel) fix that at the real seam.

Throwaway. Ships nothing. Delete before any merge to main.

## Goal

Rank five selectors on per-concurrency-key fairness under contention: the
production baseline (age-order) plus SFQ, DRR, stride, and a CoDel wrapper.
Relative ranking only, on the same axes the base-queue spike used: contention
share (arrival-aware) and per-key wait, over multiple seeds.

## Grain

The fairness group is the concurrency key. One environment, one base queue, many
concurrency keys. A "heavy" key has a large backlog; "light" keys have little.
The question: does the heavy key starve the light keys, and does each discipline
fix it?

## Approach: rescore ckIndex, drive the real Lua

The per-CK pick is `ZRANGEBYSCORE ckIndexKey -inf now` inside
`dequeueMessagesFromCkQueueTracked` (`index.ts`), i.e. lowest score first, and
the score is the CK-queue's head-message timestamp. So the discipline is
expressed by controlling that score:

- baseline: leave the scores as the Lua maintains them (head timestamp). This is
  production behaviour, unmodified.
- candidate: before each dequeue round, rewrite each active CK-queue's `ckIndex`
  score to encode the discipline's priority (virtual clock / deficit / pass),
  mapped into a `<= now` range preserving order so the Lua treats the
  highest-priority key as the oldest and serves it first.

Enqueue and acknowledge go through the real `RunQueue` (real `ckIndex`, per-CK
queues, per-CK and env concurrency, atomic Lua). The only spike affordance is the
rescore sweep before candidate dequeues, plus the `onServiced` hook that advances
discipline state per served key. In production that advance would live inside the
enqueue/dequeue Lua that maintains `ckIndex`.

Fidelity anchor: a test asserts the baseline path (no rescore) produces the same
per-key dequeue sequence as calling the real Lua directly, so the harness is a
faithful stand-in for production age-ordering.

## Components

Reuse from the base-queue spike (`../fairness-spike/`): `harness/workload.ts`
(tenant becomes concurrency-key generator), `harness/metrics.ts` (contention
share + wait, unchanged), and the selector disciplines' core logic where it
transfers. New, under `internal-packages/run-engine/src/run-queue/fairness-spike-ck/`:

- `ckReader.ts`: reads `ckIndexKey` members and each key's head score for a base
  queue.
- `ckRescorer.ts`: given a discipline priority per concurrency key, rewrites the
  `ckIndex` scores into a `<= now` order-preserving range.
- `strategies/`: sfq/drr/stride/codel keyed by concurrency key (thin adapters
  over the base-queue spike's disciplines, or shared directly).
- `harness/ckDriver.ts`: enqueues runs across concurrency keys, loops
  rescore -> real dequeue -> hold -> ack, records per-key events.
- `ckFairnessSpike.bench.test.ts`: the selector-by-scenario matrix, multi-seed.
- `FINDINGS.md`: the writeup.

## Scenarios (seeded, multi-seed)

- ckSkew: one heavy concurrency key (large backlog) vs many light keys, equal
  weight. The direct #2617 reproduction.
- ckBalanced: equal keys (sanity).
- ckTrickle: a bulk key plus keys whose runs trickle in (poisson), to exercise
  wait and the CoDel wrapper honestly.

## Out of scope

- Per-CK concurrency-limit multiplication (the other half of #2617) is a limit
  problem, not a dequeue-ordering problem; not addressed here.
- No changes to production Lua. The rescore sweep stands in for the production
  ckIndex-scoring change.
- Single shard, single environment, single base queue.

## Deliverable

The multi-seed ranking table plus `FINDINGS.md` with a proof/disproof verdict per
discipline at the concurrency-key grain, and whether the base-queue spike's
ranking carried over to the real seam.
