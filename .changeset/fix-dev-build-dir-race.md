---
"trigger.dev": patch
---

Fixes intermittent `trigger dev` run crashes where a run could fail at boot with a cryptic `Cannot find module .../dev-run-worker.mjs` after a rebuild had cleaned up the build directory the run was launched against. Dev runs now retry cleanly instead of hard-crashing when their build directory is missing, the dev watchdog no longer removes the build tree of a still-running session, and a run assigned to a worker version that was superseded by a rebuild now fails fast with a clear message instead of silently hanging until it times out.
