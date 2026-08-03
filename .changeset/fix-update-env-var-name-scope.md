---
"@trigger.dev/sdk": patch
---

Fix `updateEnvVar` incorrectly reading from an out-of-scope variable when called with the `(projectRef, slug, name, params)` overload. The `name` parameter was undefined in the implementation body; it now correctly reads from `nameOrRequestOptions`.
