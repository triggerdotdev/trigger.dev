---
"trigger.dev": patch
"@trigger.dev/core": patch
---

Attach to existing deployment for deployments triggered in the build server. If `TRIGGER_EXISTING_DEPLOYMENT_ID` env var is set, the `deploy` command now skips the deployment initialization.
