---
"@trigger.dev/sdk": patch
---

Fix `envvars.update()` throwing `ReferenceError: name is not defined` when called outside a task run (for example from a deploy script).
