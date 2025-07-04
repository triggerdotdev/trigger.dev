---
"@trigger.dev/redis-worker": patch
---

Now each worker gets it's own pLimit concurrency limiter, and we will only ever dequeue items where there is concurrency capacity, preventing incorrectly retried jobs due to visibility timeout expiry
