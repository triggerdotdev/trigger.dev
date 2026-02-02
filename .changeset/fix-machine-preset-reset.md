---
"@trigger.dev/webapp": patch
---

Fix machine preset not resetting to default when removing machine config from task (#2796)

When a task's `machine` configuration was removed and the project redeployed, runs would still execute on the old machine preset instead of resetting to the default (small-1x). This fix ensures the current deployment's machine config is always used when resolving the machine preset for a run.
