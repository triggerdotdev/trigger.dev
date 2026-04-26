---
"@trigger.dev/plugins": patch
---

RBAC plugin: mutation methods on `RoleBaseAccessController` now return discriminated `Result` types instead of throwing on expected error paths. `createRole` and `updateRole` return `RoleMutationResult` (`{ ok: true; role: Role } | { ok: false; error: string }`); `deleteRole`, `setUserRole`, `removeUserRole`, `setTokenRole`, and `removeTokenRole` return `RoleAssignmentResult` (`{ ok: true } | { ok: false; error: string }`). The webapp surfaces the `error` strings directly to users (system role edits, plan-tier gating, validation conflicts) so a thrown exception now signals only an unexpected failure (DB outage, bug). Read methods (`getUserRole`, `getTokenRole`, `allRoles`, `allPermissions`) are unchanged.
