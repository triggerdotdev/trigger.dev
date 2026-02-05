---
"@trigger.dev/core": patch
---

fix: vendor superjson to fix ESM/CJS compatibility

Bundle superjson during build to avoid `ERR_REQUIRE_ESM` errors on Node.js versions that don't support `require(ESM)` by default (< 22.12.0) and AWS Lambda which intentionally disables it.
