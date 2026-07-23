---
"@trigger.dev/core": patch
---

Add an optional `onHttpRequestComplete` callback to the supervisor worker API client so hosts can record metrics for its outbound requests (method, response status, and outcome).
