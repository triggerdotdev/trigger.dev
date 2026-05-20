---
"@trigger.dev/core": patch
---

Fix `LocalsKey<T>` type incompatibility across dual-package builds. The phantom value-type brand no longer uses a module-level `unique symbol`, so a single TypeScript compilation that resolves the type from both the ESM and CJS outputs (which can happen under certain pnpm hoisting layouts) no longer sees two structurally-incompatible variants of the same type.
