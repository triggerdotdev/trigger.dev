---
"trigger.dev": patch
---

Deployment builds now use custom base layer images and no longer install system packages during every build. This improves layer caching resulting in both faster deployments and faster image pulls on the worker cluster side.
