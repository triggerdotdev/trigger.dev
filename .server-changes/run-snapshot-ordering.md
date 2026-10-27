---
area: webapp
type: fix
---

Fix a rare case where clock skew between run engine instances could leave a run executing after its task finished, or stop a wait from ever resuming. A run's state changes are now always ordered in the order they happened, regardless of clock skew.
