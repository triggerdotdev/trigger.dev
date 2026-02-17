---
"@trigger.dev/redis-worker": patch
---

Fix slow batch queue processing by removing spurious cooloff on concurrency blocks and fixing a race condition where retry attempt counts were not atomically updated during message re-queue.
