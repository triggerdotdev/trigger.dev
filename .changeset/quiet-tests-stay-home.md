---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
"@trigger.dev/build": patch
---

Stop shipping compiled test files in the published packages. The `*.test.ts` sources were being emitted into `dist`, adding dead weight to every install and leaving modules that `require("vitest")` (not a dependency) inside the tarball, which tripped tooling that walks every file in a package.
