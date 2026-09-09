---
"@trigger.dev/core": patch
---

Add an optional `appliedSchedulePolicy` field to the schedule API response. It is present only when a non-overridable plan policy applies a minimum window to a schedule (e.g. a free-plan schedule's minimum run interval); the configured `window` continues to be returned separately and unchanged.
