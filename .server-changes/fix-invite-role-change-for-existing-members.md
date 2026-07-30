---
area: webapp
type: fix
---

Accepting an old invitation could change the role of someone who was already in the organization. An invitation now leaves an existing member's role untouched, people who are already in an organization are no longer sent invitations to it, and the invite form now says which addresses it skipped instead of failing with an unhelpful error.
