---
area: webapp
type: feature
---

Add billing limits. Customers set a spend cap; when usage crosses it, billable
environments pause for a grace period, new triggers are rejected once it ends,
and a recovery flow resumes or cancels the queued backlog. Reconciliation keeps
the webapp converged to billing's state.

## Manual pause during billing enforcement

While `pauseSource=BILLING_LIMIT`, manual resume is rejected and manual pause is
a silent no-op (`PauseEnvironmentService` returns success with state `paused`).
We do not stack a manual pause on top of billing enforcement because resolve
converge unpauses all `BILLING_LIMIT`-paused environments for the org.

API callers that pause during enforcement should expect the environment to
resume when the billing limit is resolved. The queues UI hides pause/resume in
this state; see `manualPauseEnvironmentGuard.server.ts`.

The admin `runs.enable` endpoint skips billing-paused environments when
re-enabling or disabling org runs (returns them in `skipped`, not `failures` or
the update count). They resume only after the billing limit is resolved.
