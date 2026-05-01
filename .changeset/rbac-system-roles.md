---
"@trigger.dev/plugins": patch
---

RBAC plugin: replaced `systemRoleIds()` with `systemRoles()`. The new method returns an ordered `SystemRole[]` (highest authority first) where each entry carries `id`, `name`, `description`, and `available`. The OSS no longer needs to know individual role names — it just iterates the canonical order from the plugin. `available: false` lets a plugin advertise a role without exposing it (used by v1 to ship Owner/Admin/Developer while keeping Member's prod-restriction promise unmade until the env-tier route wiring lands).
