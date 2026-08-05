---
"trigger.dev": patch
"@trigger.dev/build": patch
"@trigger.dev/core": patch
"@trigger.dev/python": patch
"@trigger.dev/react-hooks": patch
"@trigger.dev/redis-worker": patch
"@trigger.dev/rsc": patch
"@trigger.dev/schema-to-json": patch
"@trigger.dev/sdk": patch
---

Refresh package builds for TypeScript 7 compatibility while preserving existing runtime entry points. Projects using `emitDecoratorMetadata()` with TypeScript 7 can install the `@typescript/typescript6` compatibility package alongside it; the package remains optional, so installing the Trigger.dev CLI does not install an additional compiler.
