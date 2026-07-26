# Per-concurrency-key fairness spike: findings

Findings from a throwaway spike whose harness is archived (`chore/fair-queueing-spike`) and ships nothing; these findings are retained here as a design reference.

Bottom line: the base-queue spike's direction carries over to the real seam. At
the concurrency-key grain the production baseline (serve the oldest-head CK
first) starves keys that arrive behind a big backlog, and virtual-time (SFQ) and
stride fix it: they cut the starved key's wait from ~1300ms to ~20ms by making
the backlog key wait its turn. DRR does the same. A CoDel wrapper on the baseline
makes it worse. This was measured by driving the real
`dequeueMessagesFromCkQueueTracked` Lua and only rewriting `ckIndex` scores to
express each discipline. That is enough to say the ordering fix is worth a design
spike, but NOT that a production implementation is proven (see the fidelity
caveat: the spike serves one key per Lua call, and production dequeues in
batches).

## What was driven, and the two things to know before reading numbers

Runs enqueue across many concurrency keys under one base queue via the real
`RunQueue`. The per-CK pick is `ZRANGEBYSCORE ckIndexKey -inf now` in the CK Lua
(lowest score first, score = head timestamp). Candidates rewrite those scores
each round to encode discipline order; the baseline leaves them (production age
order). Enqueue, dequeue, concurrency gating and ack all run through the real
code.

Two caveats a review forced, both load-bearing:

1. Lead with wait, not contention share. The contention-share metric is
   volume-confounded for low-volume keys (a key with 15 runs cannot take a third
   of a long window even when served instantly), so on these scenarios it lands
   around 0.7 to 0.9 for a discipline that has in fact eliminated the starvation.
   The per-key wait is the clean signal.
2. The scenarios must give keys genuinely different head ages. An earlier version
   enqueued every run at one timestamp; with tied `ckIndex` scores the real Lua
   falls back to a lexicographic member-name tie-break, so the "baseline starves
   the heavy key's rivals" result was actually "Redis sorts by name" and the
   heavy key only won because "heavy" sorts before "light". Fixed: the backlog
   key fires at once (persistently old head) and the other keys arrive via
   poisson (distinct, later heads), so the baseline now exercises real age order.

## Results

`contWorstS/W` mean over 3 seeds (min..max), and the worst-served key's mean wait
(seed-a, logical ms). Read the wait column as the headline.

| scenario   | discipline | contWorstS/W        | worst-key wait | backlog-key wait |
| ---------- | ---------- | ------------------- | -------------- | ---------------- |
| ckSkew     | baseline   | 0.187 (0.186..0.188)| 1321           | 872              |
| ckSkew     | sfq        | 0.723 (0.655..0.769)| 16             | 1150             |
| ckSkew     | drr        | 0.608 (0.556..0.648)| 21             | 1149             |
| ckTrickle  | baseline   | 0.279 (0.254..0.291)| 1339           | 872              |
| ckTrickle  | sfq        | 0.909 (0.891..0.918)| 24             | 1237             |
| ckTrickle  | drr        | 0.790 (0.769..0.818)| 30             | 1236             |

Full matrix (contWorstS/W mean over 3 seeds):

| scenario   | baseline            | sfq                 | drr                 | stride | codel(sfq) | codel(baseline)     |
| ---------- | ------------------- | ------------------- | ------------------- | ------ | ---------- | ------------------- |
| ckSkew     | 0.187               | 0.723               | 0.608               | 0.723  | 0.723      | 0.104 (0.000..0.157)|
| ckBalanced | 0.515 (0.444..0.600)| 0.611 (0.462..0.800)| 0.730 (0.615..0.909)| 0.611  | 0.611      | 0.464               |
| ckTrickle  | 0.279               | 0.909               | 0.790               | 0.909  | 0.909      | 0.018 (0.000..0.055)|

## Verdict per discipline (at the concurrency-key grain)

- SFQ / stride: fix the starvation. Contention share improves (skew 0.187 to
  0.723, trickle 0.279 to 0.909) and the starved key's wait collapses (skew 1321
  to 16, trickle 1339 to 24) because the backlog key now waits its turn (its wait
  rises 872 to ~1150 to 1237). Identical to each other on every scenario.
  Recommended discipline for the fix.
- DRR: fixes the wait just as well (skew 21, trickle 30) and its contention share
  tracks SFQ within noise (sometimes a little lower, sometimes higher, e.g.
  balanced 0.730 vs 0.611). Fine.
- CoDel(sfq): no harm, matches SFQ to the decimal. Adds nothing on top of a fair
  base.
- CoDel(baseline): harmful. Hoisting stale keys on top of the age-order baseline
  drove ckSkew to 0.104 (below baseline's 0.187) and ckTrickle to 0.018 (below
  0.279). A staleness monitor is not a substitute for a fair base.
- Baseline (production age order): starves keys that queue behind a backlog
  (ckSkew 0.187, worst key waits 1321ms; ckTrickle 0.279, 1339ms). It is roughly
  fair when keys are symmetric (ckBalanced 0.515, though seed-variant 0.444 to
  0.600). This is the #2617 dynamic at the seam where it lives.

## Fidelity caveat (the reason this is not "proven for production")

The driver dequeues one key per Lua call (`maxCount = 1`) and rescores `ckIndex`
before each call. Production dequeues in batches (`maxCount` default 10). Inside a
batched CK-dequeue call the Lua re-scores each served key back to its head
timestamp as it goes, so a once-per-round rescore would only steer the FIRST pick
of a batch; the rest would follow head-timestamp order again. So this spike
demonstrates the ordering fix only in a one-key-per-call regime, which is not how
production dequeues. A real fix has to advance per-key discipline state inside the
Lua on every serve (and hold that state in Redis, not process memory). This spike
does not exercise that batch path, so the correct claim is "the ordering fix is
worth a design spike", not "a production fix is viable".

## Other caveats

- Contention share is volume-confounded (see above); the wait column is the
  trustworthy signal, and the contention numbers should be read as directional.
- The DRR contention-share gap is NOT the base-queue spike's batch-drain artifact
  (that harness batched; this one serves one key per call and advances DRR's
  deficit every serve). The cause of DRR's slightly lower share here is not
  established; its wait result is as good as SFQ's.
- Per-CK concurrency gating never binds in these runs (no per-CK limit is set, so
  it collapses to the env limit), so the spike says nothing about the per-CK
  concurrency-limit-multiplication half of #2617, which is out of scope.
- A rescore discipline advances its floor/ring state on the final no-op drain
  round of an instant (order() is called before the empty dequeue). It is
  self-correcting and does not corrupt the event-based metrics, but it is a minor
  infidelity to a production per-serve advance.
- Equal weights only; single shard, single base queue, single sequential
  consumer; simulated holds on a logical clock; 3 seeds.

## Recommended direction

Score `ckIndex` by a fair discipline (SFQ/stride virtual time, or DRR) instead of
by head timestamp. Both spikes agree on the discipline and this one shows the
ordering fix works through the real dequeue path at `maxCount = 1`. The design
spike past this needs to: advance per-key virtual-time state inside the batched
CK-dequeue Lua (the `maxCount > 1` path this spike did not exercise), hold that
state in Redis for the multi-consumer case, and address the per-CK
concurrency-limit multiplication that is the other half of #2617.
