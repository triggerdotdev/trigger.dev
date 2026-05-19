---
area: webapp
type: fix
---

Dashboard runs, sessions, batches, and schedule-detail loaders now return 404 (or redirect to the user's home with a toast for missing projects) instead of 500 when a slug doesn't resolve.
