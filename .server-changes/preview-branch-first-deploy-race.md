---
area: webapp
type: fix
---

Fixed a race that could make the first deploy of a newly created preview branch fail and eventually time out. Deploys to just-created branches now resolve reliably.
