---
"trigger.dev": patch
---

Fix `trigger deploy` failing on self-hosted instances with custom base images. Stages built on a custom image now keep the trust store that image ships with.
