---
"@trigger.dev/redis-worker": patch
---

Fair queue tenants can no longer get permanently stuck behind leaked concurrency slots. Slots are now freed on every path that finishes a message, a failed release no longer causes a message to run twice or lose its retry, and a background sweep frees any slot that does leak, so a tenant's queues recover on their own instead of needing manual cleanup.
