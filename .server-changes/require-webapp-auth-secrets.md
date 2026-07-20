---
area: webapp
type: breaking
---

Self-hosted deployments no longer ship shared default credentials; fresh installs generate their own. If yours still uses a previously published default, set a unique value before upgrading, or set `ALLOW_INSECURE_DEFAULT_SECRETS=true` to keep booting while you migrate.
