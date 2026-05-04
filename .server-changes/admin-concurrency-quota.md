---
area: webapp
type: feature
---

Admin Back office: editor for an org's concurrency quota cap (the per-org
override on how much extra concurrency the org can purchase). Sits as a new
section on the existing per-org back-office page alongside API/Batch rate
limits and Maximum projects. Calls cloud's billing service to update
billing.Limits.extraConcurrencyQuota.
