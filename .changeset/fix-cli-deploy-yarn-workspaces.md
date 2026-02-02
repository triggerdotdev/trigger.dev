---
"@trigger.dev/cli-v3": patch
---

Fix `trigger deploy` to detect and use the correct package manager (Yarn, pnpm, npm) and lockfile for builds. This fixes issues with Yarn Workspaces and ensures reproducible builds. (#2914)
