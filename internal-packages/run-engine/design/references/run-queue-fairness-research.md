# Queue-fairness research (grounding for the caps-vs-scheduling reconciliation)

Research notes distilled from a throwaway spike, retained here as a design reference. Five Fable research passes, distilled. Citations kept so
the findings write-up and report can point at real sources. This grounds the
central claim: occupancy caps and fair scheduling are orthogonal knobs, and the
plan-of-record ships the cap knob while the earlier spike measured the scheduler
knob.

## The orthogonality result (theory)

Caps bound occupancy, not wait. A tenant capped at C in-flight with mean service
time S has long-run throughput <= C/S (Little's Law, L = lambda*W). That is an
upper bound on the capped tenant's share; it reserves no lower bound for anyone
else and says nothing about any tenant's waiting time (Little relates averages in
a stable system, not tails, and if the capped tenant's arrival rate exceeds C/S
its queue never stabilises so the law does not even apply to it).

Scheduling bounds wait, not occupancy. WFQ/PGPS tracks GPS within one max job
(Parekh-Gallager finish-time bound L_max/r); SFQ gives a starved flow's head item
a hard wait bound of "one max-size job from every other active tenant" (Goyal-Vin
SFQ Theorem 2), with no server-rate assumption. But all of family A is
work-conserving: a lone backlogged tenant takes 100% of the server. Nothing in a
scheduler limits how many slots a tenant holds.

Parekh-Gallager is the canonical joint statement: a worst-case per-flow delay
bound is the product of arrival regulation (leaky/token bucket = the admission
knob) AND a scheduling discipline (GPS/WFQ = the order knob). Neither alone yields
the bound. Cruz network-calculus caveat: plain FIFO does get a delay bound IF every
input is burstiness-constrained (arrival regulator on ingress) and aggregate rho <
C, but a concurrency cap is not an ingress regulator (it bounds in-flight, not
queue admission, and queue depth stays unbounded), so under adversarial arrival
FIFO wait is unbounded and the orthogonality holds without qualification.

Sources: Little 1961 (Oper. Res. 9:383-387); Parekh & Gallager 1993/1994 (GPS,
IEEE/ACM ToN); Goyal, Vin & Cheng, Start-time Fair Queueing (SIGCOMM'96 / ToN'97);
Shreedhar & Varghese, DRR (SIGCOMM'95); Waldspurger & Weihl, Stride Scheduling
(MIT TM-528, 1995); Cruz, A Calculus for Network Delay (IEEE T-IT 1991); Kingman's
formula; Harchol-Balter, Performance Modeling and Design of Computer Systems (CUP
2013).

## When a cap alone DOES cut a starved tenant's wait (the load-bearing condition)

A per-tenant concurrency cap on heavy tenant H cuts light tenant L's wait to
near-zero iff BOTH:

1. Slot availability: sum of caps of all backlogged tenants other than L is < N
   (the binding aggregate limit), so freed slots exist that capped tenants can
   never occupy; and
2. Eligibility-aware serve order: the dequeue selects the oldest ELIGIBLE item,
   skipping items whose tenant is at cap, so L's head is reachable without
   draining H's older items first.

If (2) fails (single global age-ordered list with a head-blocking consumer), the
cap does NOT help L and with strict head-blocking makes L's wait WORSE: H's
backlog drains at k slots instead of N while the freed N-k slots sit idle
(head-of-line blocking; Parekh-Gallager's FCFS-gives-no-isolation remark).

Trigger's CK dequeue is oldest-ELIGIBLE-first: the CK Lua gates each variant at
its per-key concurrencyLimit and skips a variant that is at its limit, moving to
the next-oldest eligible. So condition (2) holds structurally. That is WHY per-key
caps can work for wait here, and would not work on a head-blocking FIFO.

## Where caps fail even with eligibility-aware order (the sybil split)

Concurrency keys are client-chosen. A heavy tenant spreads its backlog across many
CK variants, each under its own per-key cap, all "eligible". The binding
constraint becomes the base-queue total cap (or env limit); oldest-first then
serves the adversary's older backlog across its many keys before a newcomer's
head. Per-key caps bound nothing in aggregate, because sum of per-key caps is
unbounded relative to the queue cap when keys are dynamic. The light tenant's wait
scales with the adversary's total queued backlog, which no per-key cap regulates.
Within a base queue, the fix under adversarial arrival is an order change
(round-robin / fair queueing across keys), not another cap.

## Known static-cap failure modes (practice)

2DFQ (Mace et al., SIGCOMM 2016): "Rate limiters, typically implemented as token
buckets, are not designed to provide fairness at short time intervals ... they can
either underutilize the system or concurrent bursts can overload it without
providing any further fairness guarantees." Their desirable-properties section
requires the scheduler be work-conserving, which "precludes the use of ad-hoc
throttling mechanisms to control misbehaving tenants." Pisces (OSDI 2012) and DRF
(NSDI 2011) both exist because static slot partitioning under/over-utilises under
skewed demand. Netflix concurrency-limits: static limits (Limit = RPS * latency,
i.e. Little's Law) "quickly go out of date"; hence adaptive.

The price of caps when they DO give order-independent wait bounds: they degenerate
into a static partition (sum of caps <= K), which is non-work-conserving
(utilisation ceiling of sum-of-caps even when one tenant could use all K) and
needs bounded, pre-known tenant cardinality.

## Production precedent: caps and scheduling are LAYERED, not either/or

- Kubernetes API Priority & Fairness (the closest analog): total server
  concurrency split into per-priority-level "seats" (a cap), THEN shuffle-sharded
  fair queueing decides dispatch order within a level. Kubernetes hit exactly the
  cap-alone failure with max-inflight before APF, and the fix ADDED fair queueing
  on top of the existing cap rather than replacing it. (K8s docs; KEP-1040.)
- SQL Server Resource Governor: pool MIN/MAX/CAP percent (caps + reservation) +
  workload-group IMPORTANCE biasing the scheduler's order. Same shape.
- YARN Fair/Capacity scheduler: minShare floor + maxResources cap + weighted
  fair-share ordering, with preemption to reclaim the floor.
- Mesos/DRF, Borg: quota/admission caps layered with fair-share or priority order.
- Amazon SQS fair queues: fairness metric is DWELL TIME, fixed by reprioritising
  delivery ORDER when a tenant's in-flight share is disproportionate, and
  explicitly does NOT rate-limit per tenant. Order is the dwell-time knob;
  occupancy limits alone were not it.
- Envoy / gRPC / Postgres connection caps: caps ALONE, and they claim overload
  PROTECTION, not fairness. AWS token-bucket quotas claim "fairness" only in the
  weaker selective-throttling sense, and rely on an elastic, rarely-saturated
  fleet.

Condition for caps-alone to suffice in practice: sum of caps comfortably below (or
elastically kept below) real capacity, and shed/rejected work acceptable, i.e. the
system never holds a contended backlog it must drain in some order. The moment you
hold a queue of admitted-but-waiting work at saturation, the serve order IS the
fairness policy.

## CoDel (confirms the prior spike's "CoDel disproven" verdict)

CoDel is an AQM: it bounds standing-queue delay by DROPPING packets when the
minimum sojourn over a window stays above target (5ms/100ms defaults; RFC 8289).
It is not a scheduler and gives no inter-flow fairness (RFC 7567: queue management
and scheduling are complementary, not substitutes). FQ-CoDel gets all its fairness
from a DRR scheduler; CoDel is only the per-flow AQM inside each sub-queue (RFC
8290). In a durable run queue that can never drop work, CoDel's actuator is gone:
reordering conserves total queue and total work, so hoisting one item's sojourn
down pushes others' up. Hoisting the stalest item to the front of an already
age-ordered queue re-applies the age bias the base already has, so it is a no-op
at best and a dominant-tenant amplifier at worst (a tenant that dumps a big
backlog owns the entire stale set). Facebook's server-side CoDel adaptation ("Fail
at Scale", ACM Queue 2015) keeps the drop (stale requests expire) and reorders
adaptive-LIFO (newest first), the opposite of stalest-first hoisting.
