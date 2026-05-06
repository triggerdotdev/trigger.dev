---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
"trigger.dev": patch
---

Add `maxComputeSeconds` as the user-facing replacement for `maxDuration` on `defineConfig`, task definitions, and trigger options. The new name makes the unit (compute-time seconds) unambiguous at the call site. `maxDuration` is JSDoc-deprecated and still accepted; if both are set, `maxComputeSeconds` wins. The `init` templates have been updated to use the new name.
