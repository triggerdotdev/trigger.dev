---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Chat streams now stop after five failed connection retries and report a terminal error instead of remaining active indefinitely. Internal timeout exhaustion reports an error, while caller cancellation still closes cleanly. Watch subscriptions continue to retry without a fixed limit.
