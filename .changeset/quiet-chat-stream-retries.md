---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Chat streams now report `Stream stalled: no records received` after five retries of a connected stream that sends no records. Network failures and browser wakeups retain automatic recovery. Healthy tool calls with no records for about six minutes also reach this silence limit. Watch subscriptions remain unlimited, and caller cancellation still closes cleanly.
