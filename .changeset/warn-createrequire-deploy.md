---
"trigger.dev": patch
"@trigger.dev/build": patch
"@trigger.dev/core": patch
---

`deploy` and `dev` now warn, with the file, line, and suggested `additionalPackages` fix, when code loads a package through `createRequire()` that won't be available in the deployed image and would previously only fail at runtime in production.
