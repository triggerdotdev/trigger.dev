---
area: webapp
type: feature
---

RBAC: auto-assign system roles when creating an org or accepting an
invite (TRI-8854). createOrganization assigns the Owner role to the
creator; acceptInvite assigns Owner if the invite was ADMIN (defensive
— current UI only invites with MEMBER) or Member otherwise. Pairs with
the enterprise/db migration that backfills UserRole rows from existing
OrgMember.role data on RBAC go-live.
