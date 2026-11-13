---
"@trigger.dev/sdk": patch
---

`concurrencyKey` now also takes an object, so one run can be limited by two limits keyed by different things, like a cap per session and a cap per organization. `default` is the run's own key and every other entry gives a named limit its own key: `concurrencyKey: { default: sessionId, [orgLimit.name]: orgId }`. A string key works as before.
