---
area: webapp
type: improvement
---

Add a `REALTIME_BACKEND_DEFAULT` env var to choose the default realtime backend (`electric`, `native`, or `shadow`) for environments whose org has no per-org override. Defaults to `electric`, so existing behavior is unchanged.
