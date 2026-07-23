# Run-queue multi-tenant fairness: spike references

Reference material for the implementation plan
`docs/superpowers/plans/2026-07-23-ck-virtual-time-scheduling-plan.md`. These are
the findings and the queueing-theory research produced by three throwaway spikes
on RunQueue tenant fairness (#2617). The spikes' harness, bench, and results code
was throwaway and is NOT on this branch; it is archived on the remote branch
`chore/fair-queueing-spike` (never merged, delete-before-anything). Any
`internal-packages/.../fairness-spike*` paths mentioned inside these documents
refer to that archived code.

## The documents

- `run-queue-fairness-research.md` — queueing-theory grounding: SFQ/WFQ and DRR
  delay bounds, the Parekh-Gallager result that a worst-case per-flow delay bound
  needs BOTH an admission regulator and a scheduler, why CoDel is an AQM and not a
  fairness scheduler, and how production systems (Kubernetes APF, YARN, SQL Server
  Resource Governor, SQS fair queues) layer caps under a fair order.
- `run-queue-fairness-base-queue-findings.md` — spike 1, base-queue grain: ranked
  SFQ / stride / DRR / CoDel against the production age-order baseline. SFQ and
  stride fix starvation and are seed-stable; CoDel is a no-op on a fair base and
  harmful on an unfair one.
- `run-queue-fairness-ck-findings.md` — spike 2, the real concurrency-key seam:
  drove the production `dequeueMessagesFromCkQueueTracked` Lua via `ckIndex`
  rescoring. Per-key fairness lives below the selection-strategy interface, in the
  CK dequeue scoring; virtual-time ordering fixes it there. Documents the
  `maxCount = 1` fidelity limit that the implementation plan's tests must close.
- `run-queue-fairness-caps-vs-scheduling-findings.md` — spike 3, the
  reconciliation with the plan of record (which ships concurrency caps): caps and
  scheduling are orthogonal knobs. A per-key cap fixes wait when one key floods
  but gives no relief once a tenant shards across many keys (the sybil split), and
  it is not work-conserving; a total cap is a cross-task knob, not a cross-key
  one; fair scheduling fixes every case and stays work-conserving. Ship the caps
  first, add the fair order as the general fix, layer them.

## Why the plan follows from these

The recommended fix (score `ckIndex` by SFQ virtual time, inside the batched CK
dequeue, layered under the caps) is the one mechanism the spikes found that
survives key-sharding and stays work-conserving, and the research says the caps
the plan of record ships cannot bound wait on their own. The plan turns that into
a flag-gated, mixed-deploy-safe engine change with a test suite that exercises the
real batched path the spikes could not.
