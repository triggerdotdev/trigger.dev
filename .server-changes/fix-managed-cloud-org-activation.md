---
area: webapp
type: fix
---

New managed-cloud orgs were created already activated, so they skipped the select-plan flow that provisions their billing entitlement — leaving the free-tier usage cap unenforced. Managed-cloud orgs are now created deactivated and routed through select-plan, which activates them once a plan is selected. Self-hosters have no billing gate and remain active immediately.
