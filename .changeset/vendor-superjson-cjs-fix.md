---
"@trigger.dev/core": patch
---

Vendor superjson to fix CJS compatibility issue

This fixes the `ERR_REQUIRE_ESM` error that occurs when using `@trigger.dev/core` in CJS environments with Node.js versions < 22.12. The superjson package (v2.x) is ESM-only, but Node.js doesn't support `require()` of ESM modules in older versions.

The fix bundles superjson@2.2.1 using esbuild into both CJS and ESM formats, which are then imported by the existing wrapper modules. This ensures the package works correctly in all environments without relying on Node.js's experimental `require(ESM)` feature.
