---
"@trigger.dev/redis-worker": minor
---

Add `onTerminalFailure` callback to `MollifierDrainerOptions` so the customer's run lands a SYSTEM_FAILURE PG row even when the drainer exhausts `maxAttempts` on a retryable PG error. Previously, retryable-error exhaustion called `buffer.fail()` directly, which atomically marks FAILED + DELs the entry hash with no PG write — silent data loss when PG was unreachable across the full retry budget. The callback fires before `buffer.fail()` on any terminal path (`cause: "non-retryable"` or `"max-attempts-exhausted"`); throwing a retryable error from the callback causes the drainer to requeue rather than fail.
