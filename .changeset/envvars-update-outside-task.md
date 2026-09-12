---
"@trigger.dev/sdk": patch
---

`envvars.update()`: calling it outside a task run no longer throws `ReferenceError: name is not defined`. The variable name is now resolved from the positional arguments, matching the other env var methods, and a missing name raises a descriptive `name is required` error instead.
