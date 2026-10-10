---
"@trigger.dev/core": patch
"trigger.dev": patch
---

Deploys can use your own base images with `build.image.base` and `build.image.buildBase` in `trigger.config.ts`, or the `TRIGGER_BUILD_BASE_IMAGE` and `TRIGGER_BUILD_BUILD_IMAGE` environment variables. Use this for FIPS-validated or hardened Node images.
