---
"@trigger.dev/core": patch
---

Add `sanitizeBranchName` and `isValidGitBranchName` exports under `@trigger.dev/core/v3/utils/gitBranch`. These were previously webapp-internal but are now shared with the RBAC fallback's branch-aware authentication path.
