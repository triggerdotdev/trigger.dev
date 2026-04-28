---
area: webapp
type: feature
---

RBAC: PAT creation flow now lets users pick a system role at create
time, persisted as an enterprise.TokenRole row (TRI-8749). Defaults to
the caller's own role so a PAT can't be more privileged than the
person creating it. Custom (org-defined) roles are out of scope for
v1 — only the four global system roles are offered, and the binding
is global to the PAT regardless of which org the request later
targets. Compensating-delete pattern on TokenRole insert failure
keeps the two writes (Prisma PAT row + Drizzle TokenRole row)
consistent without cross-ORM transaction wrestling. OSS path is a
no-op: when the RBAC plugin isn't installed the dropdown is hidden,
no roleId is submitted, and the PAT works exactly as before.
