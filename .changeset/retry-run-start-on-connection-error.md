---
"@trigger.dev/core": patch
---

Transient connection errors when a run starts are now retried for longer, so a brief connectivity blip no longer sends the run back through the queue and delays its first attempt.
