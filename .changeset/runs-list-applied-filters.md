---
"@trigger.dev/core": patch
---

The `ListRunResponse` schema accepts an optional `appliedFilters` field. The runs list API returns it with the `createdAt` window the list used, so you can see when the default 7-day period applied.
