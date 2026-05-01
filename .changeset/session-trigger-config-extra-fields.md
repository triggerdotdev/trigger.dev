---
"@trigger.dev/core": patch
---

Extend `SessionTriggerConfig` with three optional fields previously missing from the schema: `maxDuration` (per-run wall-clock cap, seconds), `lockToVersion` (pin every run to a specific worker version), and `region` (geographic scheduling). Each forwards to the matching field on `TaskRunOptions` when the run is triggered. Existing sessions without these fields are unaffected.
