---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Use run credentials for run results, rescheduling, schedules, and environment-variable operations inside tasks. Run credentials remain limited to the current environment: shared schedules cannot be changed, and parent environment variables cannot be written.
