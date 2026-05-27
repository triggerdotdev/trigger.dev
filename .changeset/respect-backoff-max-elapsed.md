---
"@trigger.dev/core": patch
---

Stop `ExponentialBackoff.execute()` retries when callback execution time pushes the run past `maxElapsed`.
