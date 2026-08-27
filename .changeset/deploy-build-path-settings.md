---
"trigger.dev": patch
"@trigger.dev/core": patch
---

`trigger.dev deploy` now asks the server which build path to use before it builds or uploads anything, so the native build server can be enabled per organization and per environment type without a CLI change. Explicit flags still win: `--native-build-server`, `--local-bundle`, `--local-build`, and the new `--depot-build` skip the server decision entirely.
