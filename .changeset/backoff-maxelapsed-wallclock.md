---
"@trigger.dev/core": patch
---

Honor `maxElapsed` against real wall-clock time in `ExponentialBackoff.execute()`, including time spent inside the callback—not only sleep delays.
