---
"@trigger.dev/redis-worker": patch
---

Move unrecoverable items (unknown job, missing schema, or invalid payload) to the dead-letter queue instead of redelivering them indefinitely
