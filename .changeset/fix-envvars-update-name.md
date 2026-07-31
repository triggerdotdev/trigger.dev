---
"@trigger.dev/sdk": patch
---

Fix `envvars.update()` throwing `ReferenceError: name is not defined` when called outside a task context. The non-task branch referenced an out-of-scope `name` variable instead of the `nameOrRequestOptions` parameter (#4264).
