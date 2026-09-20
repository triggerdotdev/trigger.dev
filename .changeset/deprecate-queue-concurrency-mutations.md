---
"@trigger.dev/sdk": patch
---

Deprecate `queues.overrideConcurrencyLimit` and `queues.resetConcurrencyLimit`. These operate on the legacy model where a queue carried its own concurrency limit; declare concurrency with the task `concurrency` option and manage it with `concurrencyLimits.override` and `concurrencyLimits.reset` instead.
