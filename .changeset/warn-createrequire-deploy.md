---
"trigger.dev": patch
"@trigger.dev/build": patch
"@trigger.dev/core": patch
---

`deploy` and `dev` now warn when a package is loaded with `createRequire()` but won't be available in the deployed image. The bundler can't follow `createRequire()` calls, so such a package is neither bundled nor installed, and previously this failed only at runtime in production with a confusing module-not-found error (`dev` works because your local `node_modules` exists, which made the failure deploy-only). The warning points at the exact file and line and shows the `additionalPackages` config that fixes it; packages declared via `additionalPackages` don't warn. Deploys also now surface the bundler's own warnings for your files (for example `require()` with a non-literal argument) instead of discarding them. Bundling output is unchanged.
