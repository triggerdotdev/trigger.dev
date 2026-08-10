---
"trigger.dev": patch
---

Deployed images now ship dependencies and bundled task code as separate layers. Repeat deploys with unchanged dependencies push and pull far less data, making deploys and worker image pulls faster.
