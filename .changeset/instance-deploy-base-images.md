---
"@trigger.dev/core": patch
"trigger.dev": patch
---

Self-hosted instances can require custom deploy base images per runtime via the new `DEPLOY_BASE_IMAGES` and `DEPLOY_BUILD_BASE_IMAGES` webapp settings. The CLI builds on the images the instance specifies, and older CLIs are rejected with an upgrade message.
