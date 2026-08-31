---
area: webapp
type: fix
---

A durable guard improves reliability for runs waiting on triggerAndWait or batchTriggerAndWait if there's a database error that interrupts a child run finishing.
