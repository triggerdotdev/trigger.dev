---
area: webapp
type: improvement
---

Open the run span before the mollifier gate so buffered runs land in the event store with a PARTIAL span from the moment `trigger()` returns. The drainer's `mollifier.drained` span now parents on the same trace, and downstream parents (trigger-and-wait, alerting) can reference the child run span without waiting for drain.
