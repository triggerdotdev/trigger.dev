---
area: webapp
type: fix
---

Scope the `removeTeamMember` delete to the resolved organization so a member can only be deleted from the org they belong to. Previously the delete was keyed by `OrgMember.id` alone, letting a privileged caller in one org delete members of an unrelated org by id (cross-org IDOR).
