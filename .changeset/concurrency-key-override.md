---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Override a concurrency limit's `perKey` for a single `concurrencyKey`: `concurrencyLimits.override(name, { concurrencyKey, perKey, ttl })` caps that one key under that one limit for a while (7 days by default, 30 at most), `reset(name, { concurrencyKey })` clears it, and `retrieve(name, { concurrencyKey })` shows the key's bound and when the override expires.
