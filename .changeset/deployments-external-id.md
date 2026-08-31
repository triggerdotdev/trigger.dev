---
"@trigger.dev/core": patch
---

`deployments.list()` and `deployments.retrieveCurrent()` now return `externalId`, the `--external-id` a deployment was deployed under, so you can tell which deployment a version skew protection pin resolves to. Null for deployments deployed without one.
