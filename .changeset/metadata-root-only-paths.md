---
"@trigger.dev/core": patch
---

Fix parent and root metadata updates being lost after one update could not be applied. Only that update is now skipped, and the rest are written. Metadata keys that name only the root, such as `$.` or `$..`, are now ignored on a run's own metadata instead of throwing, and rejected for parent and root metadata, which fails the whole request.
