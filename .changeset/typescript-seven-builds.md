---
"trigger.dev": patch
"@trigger.dev/build": patch
"@trigger.dev/redis-worker": patch
---

Refresh package builds for TypeScript 7 compatibility while preserving existing runtime entry points. TypeScript remains an optional peer for the decorator metadata build extension, so installing the Trigger.dev CLI does not install an additional compiler.
