---
"trigger.dev": patch
"@trigger.dev/core": patch
---

`trigger.dev deploy` now asks the server whether to build with Depot or the native build server unless `--native-build`, `--depot-build`, or `--local-build` is passed, so the native build server can be rolled out per organization without a CLI change. `--local-bundle` and `--detach` now require `--native-build`.
