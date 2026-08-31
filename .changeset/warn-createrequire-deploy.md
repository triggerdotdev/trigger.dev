---
"trigger.dev": patch
"@trigger.dev/build": patch
"@trigger.dev/core": patch
---

The `trigger.dev deploy` and `trigger.dev dev` commands now warn (with the suggested fix) when your code loads a package through `createRequire()` that won't be available in the deployed image. Previously it would fail at runtime in production to load the package. Deploys also now show bundler warnings for your code instead of discarding them.
