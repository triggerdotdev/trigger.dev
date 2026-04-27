---
"@trigger.dev/plugins": patch
---

RBAC plugin: new `getAssignableRoleIds(organizationId)` method on `RoleBaseAccessController`. Returns the subset of `allRoles(organizationId)` IDs that may be assigned right now — used by the Teams page UI to disable role-dropdown options outside the org's plan tier. OSS fallback returns `[]` (permissive — `allRoles` already returns `[]` so there's nothing to gate); the enterprise plugin queries its plan client and returns the plan-allowed system roles plus all custom roles. Server-side enforcement (rejecting an actual `setUserRole` to a plan-gated role) is unchanged and remains the source of truth — this method is purely a UI affordance.
