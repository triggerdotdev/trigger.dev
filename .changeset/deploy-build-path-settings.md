---
"trigger.dev": patch
"@trigger.dev/core": patch
---

`trigger.dev deploy` now asks the server which build path to use before it builds or uploads anything, so the native build server can be enabled per organization and per environment type without a CLI change. Explicit flags still win: the new `--native-build` (`--native-build-server` stays as a hidden alias), `--local-build`, and the new `--depot-build` skip the server decision entirely. `--local-bundle` and `--detach` no longer select a build path; they apply on top of the native build server and error on Depot. A dry run never runs on the native build server anymore (it used to deploy for real with `--native-build-server --dry-run`); it bundles locally instead.
