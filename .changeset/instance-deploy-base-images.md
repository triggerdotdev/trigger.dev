---
"@trigger.dev/core": patch
"trigger.dev": patch
---

Self-hosted instances can require custom base images for deploys, such as FIPS-validated or hardened Node images, with the new `DEPLOY_BASE_IMAGES` webapp setting. The CLI builds on the base images the instance specifies.
