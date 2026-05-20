---
area: webapp
type: fix
---

Retry on unique-constraint collisions when assigning the next worker deployment version so concurrent deploys to the same environment no longer fail with P2002.
