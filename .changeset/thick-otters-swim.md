---
"trigger.dev": patch
---

Adds TRIGGER_REGISTRY_AUTH=file: deploys pass registry credentials to the image build through an ephemeral docker config instead of running docker login. Intended for managed build servers.
