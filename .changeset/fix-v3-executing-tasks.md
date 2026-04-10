---
"@trigger.dev/core": patch
---

fix(v3): remove executing tasks waiting to deploy

Removes the executing tasks that are waiting to deploy from the task list. This fixes an issue where tasks in EXECUTING state but waiting for deployment were incorrectly displayed.
