---
"@trigger.dev/plugins": patch
---

RBAC plugin: new `getAssignableRoleIds(organizationId)` method on `RoleBaseAccessController`. Returns the subset of `allRoles(organizationId)` IDs that may be assigned right now — used by the Teams page UI to disable role-dropdown options that aren't currently assignable. The default fallback returns `[]` (permissive — `allRoles` already returns `[]` so there's nothing to gate); a plugin may apply its own gating policy and return the assignable subset. Server-side enforcement (rejecting an actual `setUserRole` to a non-assignable role) is unchanged and remains the source of truth — this method is purely a UI affordance.
