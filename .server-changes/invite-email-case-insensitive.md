---
area: webapp
type: fix
---

Org member invites now match emails case-insensitively. Previously an invite
created with different casing than the invitee's account email (e.g.
"Andreas@example.com" vs "andreas@example.com") could never be accepted —
the accept route compared emails strictly and the pending-invite lookups
were exact-match. Invite emails are now lowercased on creation, and all
invite-by-email lookups (accept, decline, pending list) match
case-insensitively so existing mixed-case invite rows still work.
