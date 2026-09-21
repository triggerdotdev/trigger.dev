---
"@trigger.dev/sdk": patch
---

Fix `ReferenceError: name is not defined` when calling `envvars.update()` outside of a task context, and fix incorrect project reference resolution when specifying an explicit project and slug.
