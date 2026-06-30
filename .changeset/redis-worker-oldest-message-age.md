---
"@trigger.dev/redis-worker": patch
---

Add a `redis_worker.queue.oldest_message_age_ms` observable gauge (labeled `worker_name`) reporting the age of the oldest overdue message in each queue. This is a generic queue-stall signal: it stays at 0 while a queue drains healthily and rises only when due work sits undrained (e.g. a blocked dequeue, a dead consumer, or backpressure), even when no items are being processed. Also exposes `SimpleQueue.oldestMessageAge()`.
