---
"@trigger.dev/core": patch
---

Fix `ExponentialBackoff.execute` ignoring the `maxElapsed` boundary. The retry loop now stops once the real wall-clock time spent (callback duration plus sleeps) reaches `maxElapsed`, instead of only counting the summed sleep delays.
