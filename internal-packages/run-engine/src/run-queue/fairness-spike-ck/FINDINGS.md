# Per-concurrency-key fairness spike: findings

Throwaway spike. Ships nothing; delete before any merge to main.

Bottom line: the base-queue spike's ranking carries over to the real seam, and
more starkly. At the concurrency-key grain the production baseline (serve the
oldest-head CK first) starves other keys outright, and virtual-time (SFQ) and
stride fix it. DRR is close. A CoDel wrapper on top of the broken baseline makes
it worse. Crucially, this was measured by driving the real
`dequeueMessagesFromCkQueueTracked` Lua and its real concurrency gating; only the
`ckIndex` scores were rewritten to express each discipline, so the result says a
production fix is viable (advance the ckIndex score by a fair discipline instead
of by head timestamp).

## What was driven, and the one affordance

Runs enqueue across many concurrency keys under a single base queue via the real
`RunQueue`. The per-CK pick is `ZRANGEBYSCORE ckIndexKey -inf now` inside the CK
Lua (lowest score first, score = head timestamp). For candidates the driver
rewrites those scores each round to encode the discipline's order; the baseline
leaves them as the Lua maintains them, which is production behaviour. Enqueue,
dequeue, per-CK and env concurrency, and ack all run through the real code. The
rescore sweep and an `onServiced(key)` hook are the only affordances; in
production that advance would live in the Lua that maintains `ckIndex`. A smoke
test confirms the baseline path reproduces age-order starvation.

Fairness is measured as in the base-queue spike (arrival-aware contention share
and per-key wait), carrying forward its corrected metric and monotonic-floor
disciplines. All keys are equal weight (concurrency keys carry no configured
weight in production).

## Results

`contWorstS/W` mean over 3 seeds (min..max). Higher is fairer.

| scenario    | baseline            | sfq                 | drr                 | stride | codel(sfq) | codel(baseline) |
| ----------- | ------------------- | ------------------- | ------------------- | ------ | ---------- | --------------- |
| ckSkew      | 0.000               | 0.982 (0.946..1.000)| 0.974               | 0.982  | 0.982      | 0.000           |
| ckBalanced  | 0.000               | 0.987               | 0.987               | 0.987  | 0.987      | 0.000           |
| ckTrickle   | 0.279 (0.254..0.291)| 0.909 (0.891..0.918)| 0.790 (0.769..0.818)| 0.909  | 0.909      | 0.018           |

Per-key mean wait (seed-a, logical ms):

| scenario / discipline | starved-key wait | bulk-key wait |
| --------------------- | ---------------- | ------------- |
| ckSkew baseline       | 1853             | 872           |
| ckSkew sfq            | 265              | 1328          |
| ckTrickle baseline    | 1252             | 872           |
| ckTrickle sfq         | 22               | 1237          |

Baseline age-order drives a light key's contention share to 0 on ckSkew (it is
served only after the heavy key drains) and its wait to 1853ms; SFQ cuts that to
265ms, and on ckTrickle from 1252 to 22ms, by making the bulk key wait its turn.

## Verdict per discipline (at the concurrency-key grain)

- SFQ / stride: fix the starvation (about 0.98 on skew/balanced, 0.909 on
  trickle), seed-stable, and cut the starved key's wait 7x (skew) to 57x
  (trickle). Same as the base-queue spike. Recommended.
- DRR: close behind (0.974 skew, 0.987 balanced, 0.790 trickle). The trickle gap
  is the same batch-drain interaction noted in the base-queue spike.
- CoDel(sfq): no harm here, matches SFQ. Unlike the base-queue trickle scenario
  it did not overshoot, but it also added nothing; the fair base already bounds
  sojourn.
- CoDel(baseline): harmful. Hoisting stale keys on top of the broken baseline
  drove ckTrickle to 0.018 (worse than baseline's 0.279). A staleness monitor is
  not a substitute for a fair base.
- Baseline (production age order): starves keys at this grain. Worse than the
  base-queue proxy (0.000 vs 0.288 there), because a concurrency key with a
  backlog of old heads is served to exhaustion before newer keys get a turn. This
  is #2617 measured at the seam where it actually lives.

## Caveats

- The rescore sweep stands in for a production change to how `ckIndex` scores are
  maintained. The spike proves the ordering fix works through the real dequeue
  Lua and concurrency gating; it does not implement or measure the production
  wiring (which would advance the score inside the enqueue/dequeue Lua and hold
  per-key discipline state in Redis, not process memory).
- ckBalanced baseline reading 0.000 is partly a tie-break artifact: with equal
  enqueue timestamps the age order is a deterministic member-name tie-break that
  parks one key last during a short contention window. The direction (baseline
  unfair, candidates fair) is right; lean on ckSkew and the wait numbers for the
  magnitude.
- Equal weights only; single shard, single base queue, single sequential
  consumer; simulated holds on a logical clock; 3 seeds (shows the baseline's
  failure and the virtual-time schemes' stability, not a statistical study).
- The other half of #2617, per-CK concurrency-limit multiplication, is a limit
  problem not a dequeue-ordering one, and is out of scope here.

## Recommended direction

The fix for #2617 at the CK grain is to score `ckIndex` by a fair discipline
(SFQ/stride virtual time, or DRR) instead of by head timestamp, advancing the
per-key state inside the Lua that maintains `ckIndex`. Both spikes agree on the
discipline; this one shows it works at the real seam. Next step past the spike is
a design for holding per-key virtual-time state in Redis and advancing it in the
enqueue/dequeue Lua, plus the multi-shard/multi-consumer story neither spike
covers.
