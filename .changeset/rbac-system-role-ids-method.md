---
"@trigger.dev/plugins": patch
---

RBAC plugin: new `systemRoleIds(): Promise<SystemRoleIds | null>` method on `RoleBaseAccessController`. Returns `{ owner, admin, developer, member }` with the seed-migration role IDs when a plugin is loaded; returns `null` when no plugin is installed (matches the `allRoles → []` semantics — there are no seeded roles to refer to). Lets consumers (invite flow, PAT defaults, Roles page comparison grid) get the canonical IDs without duplicating constants in the consuming app.
