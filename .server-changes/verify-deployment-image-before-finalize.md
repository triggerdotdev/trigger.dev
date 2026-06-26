---
area: webapp
type: fix
---

Verify a deployment's image exists in the registry before marking it deployed, so a deploy whose image wasn't pushed fails instead of silently breaking runs (can be turned off via `DEPLOY_IMAGE_VERIFICATION_ENABLED=0` for setups that push images out of band)
