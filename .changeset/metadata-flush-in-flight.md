---
"@trigger.dev/core": patch
---

Fix run metadata changes sometimes reaching the API only when the run finished, so realtime subscribers and parent runs didn't see progress while the task was still running. This also fixes a metadata `append` or `increment` occasionally being applied twice at the end of a run, and a new run that reused the previous run's process sometimes seeing that run's metadata values.
