---
"trigger.dev": patch
---

Deploys are faster: images no longer install system packages during every build, and repeat deploys pull less because the shared base layers are already cached. Custom packages from the aptGet extension still install as before.
