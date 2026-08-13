---
"trigger.dev": patch
---

Deployed images now build on prebuilt base images (triggerdotdev/node and triggerdotdev/bun on Docker Hub) instead of installing system packages during every build. Builds skip the package installation step entirely, and the base layers are identical across all projects, so worker nodes cache one copy fleet-wide and image pulls get faster. Custom packages from the aptGet extension install on top as before.
