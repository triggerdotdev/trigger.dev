---
"@trigger.dev/core": patch
---

Runs that don't continue an incoming trace are no longer merged into one trace when they execute on the same warm worker process. Each run now appears as its own trace in your external observability tool, so per-run cost and latency attribution works again.
