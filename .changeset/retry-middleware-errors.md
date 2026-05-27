---
"@trigger.dev/core": patch
---

Retry `TASK_MIDDLEWARE_ERROR` under the task's retry policy instead of failing the run on the first attempt. The error was already classified as retryable by `shouldRetryError`, but `shouldLookupRetrySettings` did not include it, so the retry flow fell through to `fail_run`. Fixes #3231.
