---
"trigger.dev": patch
---

Deploys now warn when a package is loaded with `createRequire()` but won't be available in the deployed image. The bundler can't follow `createRequire()` calls, so such a package is neither bundled nor installed, and previously this failed only at runtime with a confusing module-not-found error. The warning points at the exact file and line and suggests the `additionalPackages` build extension. Deploys also now surface the bundler's own warnings for your files (for example `require()` with a non-literal argument) instead of discarding them.
