---
"@trigger.dev/plugins": minor
---

RBAC plugin: `RoleBaseAccessController.authenticateAuthorizeBearer` and `authenticateAuthorizeSession` now accept `RbacResource | RbacResource[]` for `check.resource`, matching `RbacAbility.can`. This was an inconsistency — abilities accepted arrays but the convenience methods didn't, so callers wanting the array form had to call `authenticateBearer` + `ability.can` manually.
