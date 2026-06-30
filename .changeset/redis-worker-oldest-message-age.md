---
"@trigger.dev/redis-worker": patch
---

Add a `redis_worker.queue.oldest_message_age` observable gauge (unit `ms`, labeled `worker_name`) reporting the age of the oldest overdue message in each queue. This is a generic queue-stall signal: it stays at 0 while a queue drains healthily and rises only when due work sits undrained (e.g. a blocked dequeue, a dead consumer, or backpressure), even when no items are being processed. Orphaned queue entries are resolved against the items hash so they don't report a phantom stall. Also exposes `SimpleQueue.oldestMessageAge()`.
