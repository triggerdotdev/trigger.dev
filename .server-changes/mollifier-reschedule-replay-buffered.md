---
area: webapp
type: feature
---

Reschedule and replay APIs now handle buffered runs.

`POST /api/v1/runs/{id}/reschedule` switches to `mutateWithFallback`. PG hits go through the existing `RescheduleTaskRunService` (which enforces `status === "DELAYED"`). Buffered-QUEUED hits land a `set_delay` patch on the snapshot; the drainer materialises the PG row with the new `delayUntil`. `busy` snapshots wait for drainer resolution then route through PG. Synthesised response returns `{ id, delayUntil }` for the SDK to confirm.

`POST /api/v1/runs/{id}/replay` adds a read-fallback after the PG miss: when the original run is still in the buffer, the synthesised TaskRun (extended in Phase B4 with all `ReplayTaskRunService`-relevant fields) is passed straight to the existing replay service. Replay creates a fresh trigger that itself re-enters the mollifier gate — no special surge handling needed. Also tightens the PG lookup to `findFirst` with `runtimeEnvironmentId` scoping; the prior `findUnique` left auth boundary checks to the upper layer.
