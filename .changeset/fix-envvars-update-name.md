---
"@trigger.dev/sdk": patch
---

`envvars.update(projectRef, slug, name, params)` no longer throws `ReferenceError: name is not defined` when called from a Node script outside a task run.
