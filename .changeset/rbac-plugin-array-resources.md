---
"@trigger.dev/plugins": minor
---

RBAC plugin: `RbacAbility.can(action, resource)` now accepts either a single `RbacResource` or `RbacResource[]`. Array form means "grant access if any resource in the array passes", matching the multi-key authorisation semantics expected by routes that touch multiple resources (e.g. a run that also carries a batch id, tags, and a task identifier — a JWT scoped to any of them grants access).
