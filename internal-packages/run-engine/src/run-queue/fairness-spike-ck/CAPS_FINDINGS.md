# Caps vs scheduling: reconciliation findings

Throwaway spike. Ships nothing; delete before any merge to main.

Bottom line: the plan-of-record's concurrency CAPS and the earlier spike's fair
SCHEDULING are different knobs, and the data on the real CK-dequeue Lua matches
the queueing theory (see `RESEARCH.md`). A per-key cap fixes a starved key's wait
when ONE key floods, because Trigger's CK dequeue is oldest-eligible-first, but it
FAILS when a tenant shards its backlog across many concurrency keys (the sybil
split), and it is not work-conserving. Fair scheduling (SFQ/DRR) fixes the wait on
every scenario, including the sybil split, and stays work-conserving. A total
(per-task) cap does not address cross-key starvation at all: applied inside a task
it only lowers the ceiling and makes the starved key's wait worse. The two
mechanisms are complementary, and every production system that needs fairness
under saturation layers them (Kubernetes APF: seats + fair queueing).

## How the caps were modelled (fidelity)

- Per-key cap (Phase 2): the REAL Lua gate. `updateQueueConcurrencyLimits` sets
  the base queue's concurrencyLimit, and the CK-dequeue Lua caps each ck variant's
  in-flight at it and skips an at-limit variant (oldest-eligible-first, true age
  order, no rescore involved). Uniform across variants: Phase 2's per-key HGET
  override would cap only the heavy key, but a light key never approaches the cap
  so the effect is equivalent here. (This also means "just lower the existing
  per-queue concurrency limit" is itself a per-key cap; Phase 2 makes it
  per-key-specific.)
- Total cap (Phase 1): driver-side. The real Lua has no group gate yet, so the
  driver refuses to admit while total in-flight across all variants of the base
  queue (= `:groupConcurrency` SCARD in one base queue) is at the cap.
- Ordering disciplines (baseline age order, SFQ, DRR) are unchanged from the CK
  scheduling spike, driven through the same real Lua at `maxCount = 1`.
- Same `maxCount = 1` fidelity caveat as the CK spike: production dequeues in
  batches, so a real per-key/total gate lives inside the batched Lua.

## Results

env=4, per-key cap=2, total cap=2, 3 seeds. `lightWait` = the starved key's mean
wait (logical ms), the headline. `makespan` = drain time (work-conservation
signal). `contWorstS/W` = worst contention share over weight (directional).

| scenario    | treatment      | lightWait | worstWait | makespan | contWorstS/W |
| ----------- | -------------- | --------- | --------- | -------- | ------------ |
| ckSkew      | baseline       | 1098      | 1261      | 2083     | 0.187        |
| ckSkew      | perKeyCap      | 20        | 1555      | 3038     | 0.814        |
| ckSkew      | totalCap       | 2840      | 2974      | 3947     | 0.213        |
| ckSkew      | sfq            | 14        | 1069      | 2083     | 0.723        |
| ckSkew      | drr            | 17        | 1067      | 2083     | 0.608        |
| ckSkew      | perKeyCap+sfq  | 7         | 1628      | 3114     | 0.800        |
| ckTrickle   | baseline       | 1107      | 1134      | 1940     | 0.279        |
| ckTrickle   | perKeyCap      | 19        | 1555      | 3038     | 0.922        |
| ckTrickle   | totalCap       | 2852      | 2861      | 3905     | 0.279        |
| ckTrickle   | sfq            | 17        | 1070      | 1942     | 0.909        |
| ckTrickle   | drr            | 23        | 1069      | 1941     | 0.790        |
| ckTrickle   | perKeyCap+sfq  | 8         | 1606      | 3097     | 0.658        |
| ckSybil     | baseline       | 1767      | 1823      | 2067     | 0.000        |
| ckSybil     | perKeyCap      | 1718      | 1831      | 2148     | 0.367        |
| ckSybil     | totalCap       | 3796      | 3796      | 4147     | 0.000        |
| ckSybil     | sfq            | 462       | 1062      | 2068     | 0.690        |
| ckSybil     | drr            | 496       | 1081      | 2071     | 0.690        |
| ckSybil     | perKeyCap+sfq  | 462       | 1062      | 2068     | 0.690        |
| ckHeavyIdle | baseline       | 633       | 633       | 1240     | 1.000        |
| ckHeavyIdle | perKeyCap      | 1291      | 1291      | 2507     | 1.000        |
| ckHeavyIdle | totalCap       | 1291      | 1291      | 2507     | 1.000        |
| ckHeavyIdle | sfq            | 633       | 633       | 1240     | 1.000        |
| ckHeavyIdle | drr            | 633       | 633       | 1240     | 1.000        |
| ckHeavyIdle | perKeyCap+sfq  | 1291      | 1291      | 2507     | 1.000        |

(ckHeavyIdle is a single key, so "lightWait" is the heavy key's own wait and the
contention metric is degenerate at 1.0; the signal there is makespan.)

## Verdicts

- Per-key cap (Phase 2): PROVEN for the single-heavy case, DISPROVEN for the
  sybil case, and it is not work-conserving.
  - Single heavy key (ckSkew/ckTrickle): cuts the light key's wait like a
    scheduler (1098 to 20, 1107 to 19) because capping the one heavy key frees
    slots and the CK Lua is oldest-eligible-first, so the light key's head is
    reachable. This works ONLY because the dequeue skips at-cap variants; on a
    head-blocking FIFO the same cap would idle the freed slots and make wait worse.
  - Sybil split (ckSybil): barely moves the light key's wait (1767 to 1718)
    because the attacker's 10 keys keep env saturated with older heads and no
    per-key cap bounds their aggregate. Only the fair order rescues the light key
    (sfq 462, ~3.7x better than perKeyCap). Concurrency keys are client-chosen, so
    this is cheap to trigger.
  - Not work-conserving: throttles the capped key even with the env idle
    (ckHeavyIdle makespan 1240 to 2507, 2x; ckSkew 2083 to 3038, +46%).
- Total cap (Phase 1) for cross-KEY fairness: DISPROVEN. Applied inside one task
  it only lowers the whole task's ceiling and, with age order unchanged, makes the
  starved key's wait worse on every contended scenario (ckSkew 1098 to 2840,
  ckSybil 1767 to 3796). The total cap's real job is cross-TASK isolation
  (reservation between base queues when the sum of per-task caps is below the env
  limit); that is a different problem from #2617's within-task cross-key
  starvation and is not exercised by this single-base-queue harness (noted as
  future work).
- Scheduling (SFQ/DRR): PROVEN on every scenario including the sybil split, and
  work-conserving (makespan stays at the baseline optimum 2083/1240). SFQ and DRR
  track each other within noise, as in the CK spike.
- Layered per-key cap + SFQ (the Kubernetes-APF pattern): best of both on the
  single-heavy case (lowest light wait AND the cap's occupancy bound), but
  inherits the static cap's makespan penalty (ckSkew 3114, ckHeavyIdle 2507). On
  the sybil case the cap adds nothing and SFQ does all the work (462). APF avoids
  the work-conservation penalty by making the cap ELASTIC (borrow/lend seats); a
  static cap cannot.

## Reconciliation with the earlier spike and the plan of record

- The earlier spike's recommendation (score `ckIndex` by a fair discipline) is the
  general fix: it is the only mechanism here that survives the sybil split and it
  is work-conserving.
- The plan of record ships caps first, and that is a defensible sequencing, not a
  contradiction. A per-key cap is bounded, predictable, operator-controlled, and
  self-healing (a Redis SET), and it fully fixes the common single-heavy-key case
  with far less engine risk than reworking the dequeue scoring. Its limits are
  real (defeated by key sharding, not work-conserving), which is exactly why the
  plan calls automatic elastic fairness a later, opt-in phase.
- The honest layered conclusion (matching Kubernetes APF, SQL Server Resource
  Governor, YARN, and the Parekh-Gallager result that a delay bound needs BOTH an
  admission regulator AND a scheduler): keep the caps for isolation and
  entitlements, and add a fair dequeue order for the contended region when
  saturation and key-sharding make caps alone insufficient. Not either/or.

## Caveats

- Relative ranking only; single shard, single base queue, single sequential
  consumer; simulated holds on a logical clock; 3 seeds; equal weights.
- `maxCount = 1` (see fidelity note); the total cap is driver-modelled, not the
  real (unbuilt) group gate.
- Per-key cap is modelled uniformly (real per-queue gate); a per-key-specific
  Phase-2 override is equivalent here only because the light key never approaches
  the cap.
- Cross-task isolation (the total cap's real purpose) is argued from the research,
  not measured; a multi-base-queue harness is future work.
- Wait is the trustworthy signal; contention share is volume-confounded for
  low-volume keys (same caveat as the CK spike).
