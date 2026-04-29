---
area: webapp
type: feature
---

RBAC: PAT creation flow now lets users pick a system role at create
time, persisted via the RBAC plugin's `setTokenRole`. Defaults to the
caller's own role so a PAT can't be more privileged than the person
creating it. Custom (org-defined) roles are out of scope for v1 — only
the four global system roles are offered, and the binding is global to
the PAT regardless of which org the request later targets. A
compensating-delete on `setTokenRole` failure keeps the PAT row and
the role row consistent without cross-store transaction wrestling.
With no RBAC plugin installed the dropdown is hidden, no roleId is
submitted, and the PAT works exactly as before.
