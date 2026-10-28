---
"@trigger.dev/core": patch
---

Add `SupervisorHttpClient.releaseRun`, which gives back a dequeued run the worker never started so the platform requeues it at once instead of after the pending execution timeout.
