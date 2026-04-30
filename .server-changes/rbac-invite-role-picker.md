---
area: webapp
type: feature
---

RBAC: invite flow now lets the inviter pick the new member's role.
The dropdown is filtered to roles the inviter is allowed to assign
(strictly below their own level — Owner > Admin > Developer > Member)
and gated by the org's plan tier (so Free/Hobby see Owner+Admin, Pro+
unlocks Developer+Member). With no RBAC plugin installed the picker
is hidden entirely and the legacy invite flow is unchanged.

Schema: new nullable `OrgMemberInvite.rbacRoleId text` column. Legacy
`role` enum stays untouched and is set to ADMIN or MEMBER based on
the chosen RBAC role for OSS-side auth compatibility. On accept, when
`rbacRoleId` is non-null the plugin's `setUserRole` is called after
the OrgMember insert; otherwise the runtime fallback derives the role
from the legacy `role` field.
