---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Add `region` to the runs list / retrieve API: filter runs by region (`runs.list({ region: "..." })` / `filter[region]=<masterQueue>`) and read each run's executing region from the new `region` field on the response.
