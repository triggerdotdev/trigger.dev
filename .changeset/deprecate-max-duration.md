---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
"trigger.dev": patch
---

Deprecate `maxDuration` in favor of `maxComputeSeconds` because it's clearer. The new `maxComputeSeconds` property better reflects that the limit is based on compute time (CPU time) rather than wall-clock time. The old `maxDuration` property is still supported for backwards compatibility but will show deprecation warnings.
