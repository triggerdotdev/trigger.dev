---
"@trigger.dev/core": patch
---

Deployments now return the `--external-id` they were deployed under as `externalId`, and a run can read its own from `ctx.deployment.externalId`. Also fixes the deployments list failing when one deployment had no git metadata.
