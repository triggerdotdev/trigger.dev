---
"trigger.dev": patch
---

Skip spinner message truncation in non-TTY environments and make truncation O(n), so large deploys no longer hang at 100% CPU in CI.
