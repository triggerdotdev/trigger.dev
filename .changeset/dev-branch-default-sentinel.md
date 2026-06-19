---
"@trigger.dev/core": patch
"trigger.dev": patch
---

Centralize the `"default"` dev-branch sentinel behind a shared `DEFAULT_DEV_BRANCH` constant and `isDefaultDevBranch()` helper in `@trigger.dev/core/v3/utils/gitBranch`, replacing the hardcoded string literals duplicated across the CLI and server. No behavior change — `trigger dev` still targets the root development environment when no branch is specified.
