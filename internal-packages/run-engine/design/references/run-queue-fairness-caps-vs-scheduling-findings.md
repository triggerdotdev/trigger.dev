# Caps vs scheduling: reconciliation findings

Findings from a throwaway spike whose harness is archived (`chore/fair-queueing-spike`) and ships nothing; these findings are retained here as a design reference. Relative ranking
on a small simulation, not a statistical or load study: read the verdicts as "what
this harness supports", not proofs. Went through a blind two-model adversarial
review (a third stalled); the review's fixes are folded in below.

Bottom line: the plan-of-record's concurrency CAPS and the earlier spike's fair
SCHEDULING are different knobs, and the data on the real CK-dequeue Lua lines up
with the queueing theory (see `RESEARCH.md`). A per-key cap cuts a starved key's
wait when ONE key floods, because Trigger's CK dequeue is oldest-eligible-first;
it gives no wait improvement once a tenant shards its backlog across many
concurrency keys, and it is not work-conserving. Fair scheduling (SFQ/DRR) is the
only knob here that improves the starved key on every scenario including the
sharded one, and it stays work-conserving. A total (per-task) cap is a
cross-task knob; inside one task it only lowers the ceiling and is not a fairness
lever at all. The mechanisms are complementary, and production systems that need
fairness under saturation layer them (Kubernetes APF: seats + fair queueing).

## How the mechanisms were modelled (fidelity)

- Per-key cap (Phase 2): the REAL Lua gate. `updateQueueConcurrencyLimits` sets
  the base queue's concurrencyLimit; the CK-dequeue Lua caps each ck variant's
  in-flight at it and skips an at-limit variant (oldest-eligible-first, true age
  order, no rescore). Uniform across variants: Phase 2's per-key HGET override
  would cap only the heavy key, but a light key never approaches the cap so the
  effect is equivalent here. (So "just lower the existing per-queue concurrency
  limit" already IS a per-key cap; Phase 2 makes it per-key-specific.)
- Total cap (Phase 1): driver-side. The real Lua has no group gate yet, so the
  driver refuses to admit while total in-flight across all variants of the base
  queue (= `:groupConcurrency` SCARD in one base queue) is at the cap.
- Ordering disciplines (baseline age order, SFQ, DRR) are unchanged from the CK
  scheduling spike, driven through the same real Lua at `maxCount = 1`.
- Two fidelity limits matter for reading the numbers, both driver-independent:
  - `maxCount = 1` (same as the CK spike): production dequeues in batches, so a
    real per-key/total gate lives inside the batched Lua.
  - The `*3` scan window: the real CK Lua reads `ZRANGEBYSCORE ckIndexKey -inf now
    LIMIT 0, actualMaxCount*3` (`index.ts:4041/4193`). At `maxCount = 1` that is
    the 3 oldest-scored variants per call. So a per-key cap frees the light key
    only when the light head lands inside that 3-wide window after the at-cap
    variants ahead of it. With one heavy key it does; with many old-headed
    attacker variants it never does. This window governs the skew-works /
    sharded-fails split, and it scales with `maxCount` in production (batches),
    not fixed at 3, so the sharded result's exact severity would differ on the
    real batched path (direction not established).

## Results

env=4, per-key cap=2, total cap=2, 3 seeds. Columns: `lightWait` = the starved
key's mean wait (logical ms, the headline where it is not confounded);
`worstWait` = the largest per-group mean wait (i.e. the busiest key, which a fair
discipline deliberately makes wait its turn, so higher here is often correct);
`makespan` = logical time of the last dequeue (a work-conservation signal ONLY on
ckHeavyIdle, arrival-confounded elsewhere); `contWorstS/W` = worst contention
share over weight (directional; volume-confounded and, for per-key cap on sybil,
seed-noisy).

| scenario    | treatment          | lightWait | worstWait | makespan | contWorstS/W |
| ----------- | ------------------ | --------- | --------- | -------- | ------------ |
| ckSkew      | baseline           | 1098      | 1261      | 2083     | 0.187        |
| ckSkew      | perKeyCap          | 20        | 1555      | 3038     | 0.814        |
| ckSkew      | totalCap           | 2840      | 2974      | 3947     | 0.213        |
| ckSkew      | total+perKey       | 2840      | 2974      | 3947     | 0.213        |
| ckSkew      | sfq                | 14        | 1069      | 2083     | 0.723        |
| ckSkew      | drr                | 17        | 1067      | 2083     | 0.608        |
| ckSkew      | perKeyCap+sfq      | 7         | 1628      | 3114     | 0.800        |
| ckSkew      | total+perKey+sfq   | 52        | 2363      | 3939     | 0.803        |
| ckTrickle   | baseline           | 1107      | 1134      | 1940     | 0.279        |
| ckTrickle   | perKeyCap          | 19        | 1555      | 3038     | 0.922        |
| ckTrickle   | totalCap           | 2852      | 2861      | 3905     | 0.279        |
| ckTrickle   | total+perKey       | 2852      | 2861      | 3905     | 0.279        |
| ckTrickle   | sfq                | 17        | 1070      | 1942     | 0.909        |
| ckTrickle   | drr                | 23        | 1069      | 1941     | 0.790        |
| ckTrickle   | perKeyCap+sfq      | 8         | 1606      | 3097     | 0.658        |
| ckTrickle   | total+perKey+sfq   | 106       | 2337      | 3911     | 0.883        |
| ckSybil     | baseline           | 1765      | 1876      | 2070     | 0.000        |
| ckSybil     | perKeyCap          | 1776      | 1869      | 2128     | 0.403        |
| ckSybil     | totalCap           | 3793      | 3801      | 4147     | 0.000        |
| ckSybil     | total+perKey       | 3793      | 3801      | 4147     | 0.000        |
| ckSybil     | sfq                | 1009      | 1019      | 2065     | 1.000        |
| ckSybil     | drr                | 1061      | 1068      | 2055     | 0.994        |
| ckSybil     | perKeyCap+sfq      | 1010      | 1019      | 2072     | 1.000        |
| ckSybil     | total+perKey+sfq   | 2292      | 2292      | 4146     | 1.000        |
| ckHeavyIdle | baseline           | 633       | 633       | 1240     | 1.000        |
| ckHeavyIdle | perKeyCap          | 1291      | 1291      | 2507     | 1.000        |
| ckHeavyIdle | totalCap           | 1291      | 1291      | 2507     | 1.000        |
| ckHeavyIdle | total+perKey       | 1291      | 1291      | 2507     | 1.000        |
| ckHeavyIdle | sfq                | 633       | 633       | 1240     | 1.000        |
| ckHeavyIdle | drr                | 633       | 633       | 1240     | 1.000        |
| ckHeavyIdle | perKeyCap+sfq      | 1291      | 1291      | 2507     | 1.000        |
| ckHeavyIdle | total+perKey+sfq   | 1291      | 1291      | 2507     | 1.000        |

(ckHeavyIdle is a single key, so "lightWait" is the heavy key's own wait and the
contention metric is degenerate at 1.0; makespan is the signal there. ckSybil is
20 attacker keys plus one light key.)

## What each mechanism does, at the cross-key grain

- Per-key cap (Phase 2). SUPPORTED for the single-heavy case; NOT a wait fix once
  the tenant shards; not work-conserving.
  - Single heavy key (ckSkew/ckTrickle): cuts the light key's wait like a
    scheduler (1098 to 20, 1107 to 19) because capping the one heavy key frees
    slots and the CK Lua serves the light head as the next eligible one. This
    depends on the light head being reachable inside the Lua's 3-wide scan window;
    with one at-cap variant ahead of it, it is.
  - Sharded / sybil (ckSybil, 20 attacker keys): NO wait improvement (baseline
    1765, perKeyCap 1776; the difference is within the per-seed spread, baseline
    1681..1926, perKeyCap 1672..1861). Contention share nudges up (0.000 to a
    mean 0.403) but that mean hides a ~10x seed swing (0.07..0.71), so it is not a
    dependable improvement. The reason is structural: the sum of per-key caps is
    unbounded relative to the queue when keys are client-chosen, and the 3-wide
    scan window is always full of older attacker heads, so the light head is never
    reached. Concurrency keys are client-chosen, so this is cheap to trigger.
  - Not work-conserving: throttles the capped key even with the env idle
    (ckHeavyIdle makespan 1240 to 2507, 2x, the cleanest single result in the
    spike; ckSkew 2083 to 3038, though that scenario's makespan is partly arrival-
    confounded).
- Total cap (Phase 1) at the cross-key grain: NOT a fairness lever, and the
  in-task comparison is capacity-confounded. `totalCap=2` caps the whole task's
  aggregate at half of env=4, so it simply halves throughput: light's wait rises
  (ckSkew 1098 to 2840) for the same reason heavy's does (both now share half the
  server), which is Little's-Law throughput loss, not a fairness effect. It is the
  wrong knob for cross-key starvation, measured on a lower ceiling; do not read
  the "worse" numbers as "total caps harm fairness."
- Total cap (Phase 1) at the cross-TASK grain: this IS its job, and it works.
  Measured in a separate multi-base-queue bench (`crossTaskCaps.bench.test.ts`):
  two keyless tasks share one env, a heavy task floods it, and capping the heavy
  task (its per-queue concurrency limit, the real native gate, which for a keyless
  task equals its total cap) cuts the light TASK's wait from 475 to 2 under the
  production `FairQueueSelectionStrategy`. So the total cap protects a light task
  from a heavy task, the reservation-isolation role the research describes. It is
  still not work-conserving (makespan 2039 to 3039), and SFQ at the task grain
  protects the light task too (wait 14) while staying work-conserving (2039). The
  fidelity note: this models a KEYLESS task, so the per-queue limit is the total;
  a task WITH concurrency keys needs the group SET to sum across variants (the
  unbuilt Phase-1 gate).
- Combined total + per-key (the shipped Phase-1+2 config): in this toy the total
  cap (2) is below a single per-key cap's reach, so it dominates and the per-key
  cap is non-binding (`total+perKey` equals `totalCap` to the digit). This toy
  therefore does not exercise the combined config's real regime (total >> per-key,
  cross-task). What it does show: adding a fair order on top (`total+perKey+sfq`)
  restores fair share within the throttled aggregate (contWorstS/W 0.80..1.0) but
  still pays the total cap's throughput loss (makespan ~3900+).
- Scheduling (SFQ/DRR): the only knob that improves the starved key on every
  scenario, and work-conserving (makespan stays at the baseline optimum
  2083/1240). On the sharded case SFQ takes the light key from fully starved to
  its full fair share (contWorstS/W 0.000 to 1.000, seed-stable) and roughly
  halves its wait (1765 to 1009); the residual wait is real saturation shared
  fairly across 21 keys, not starvation. SFQ and DRR track each other within
  noise, as in the CK spike.
- Layered per-key cap + SFQ: best light-key wait on the single-heavy case (7, 8)
  and it carries the cap's occupancy bound, at the cap's makespan cost (matches or
  slightly exceeds perKeyCap makespan: ckSkew 3038 to 3114). On the sharded case
  the cap adds nothing and SFQ does all the work (1010, same as SFQ alone). This
  is the Kubernetes-APF shape; APF avoids the work-conservation cost by making the
  cap ELASTIC (borrow/lend seats), which a static cap cannot.

## Reconciliation with the earlier spike and the plan of record

Measured here: caps and scheduling fix different things and can be layered
(the per-key-cap+SFQ and total+perKey+sfq rows). Fair scheduling is the only
mechanism in this harness that improves the starved key on the sharded case and
stays work-conserving, which is what the earlier spike recommended (score
`ckIndex` by virtual time).

Interpretation, NOT measured by this benchmark (it measures wait/makespan/share on
a simulation, not engineering cost or rollout risk): shipping the caps first still
reads as defensible. A per-key cap is bounded, operator-controlled, self-healing
(a Redis SET), and it fully fixes the common single-heavy-key case, which is a
smaller engine change than reworking the dequeue scoring. Its limits are real
(no help once a tenant shards its keys, not work-conserving), which is the case
for treating automatic fair scheduling as a later phase rather than never.

The layered end state matches Kubernetes APF, SQL Server Resource Governor, YARN,
and the Parekh-Gallager result that a worst-case delay bound needs BOTH an
admission regulator AND a scheduler: keep the caps for isolation and entitlements,
add a fair dequeue order for the contended region when saturation and key-sharding
make caps alone insufficient. Not either/or.

## Caveats

- Relative ranking on a simulation; single shard, single base queue, single
  sequential consumer; simulated holds on a logical clock; 3 seeds; equal weights.
  The verdict words ("supported", "not a wait fix") are relative to this harness.
- `maxCount = 1` and the `*3` scan window (see fidelity section); the total cap is
  driver-modelled, not the real (unbuilt) group gate.
- Per-key cap is modelled uniformly (real per-queue gate); a per-key-specific
  Phase-2 override is equivalent here only because the light key never approaches
  the cap.
- makespan is the last dequeue, not completion, and is arrival-confounded on the
  poisson scenarios; trust it only on ckHeavyIdle.
- Contention share is volume-confounded for low-volume keys, and for the per-key
  cap on the sharded case it is seed-noisy (0.07..0.71); wait is the trustworthy
  signal, share is directional.
- Cross-task isolation (the total cap's real purpose) is now measured in
  `crossTaskCaps.bench.test.ts` for KEYLESS tasks (per-queue limit = total cap).
  A task with concurrency keys needs the unbuilt group-SET gate to sum across
  variants; that batched, keyed path is still not exercised.
