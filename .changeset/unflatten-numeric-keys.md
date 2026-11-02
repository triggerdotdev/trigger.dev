---
"@trigger.dev/core": patch
---

Fix logs and spans with large numeric object keys failing to ingest and dropping the rest of their batch.
