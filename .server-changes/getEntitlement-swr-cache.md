---
area: webapp
type: improvement
---

Add 60s fresh / 60s stale SWR cache to `getEntitlement` in `platform.v3.server.ts`. Eliminates a synchronous billing-service HTTP round trip on every trigger. Reuses the existing `platformCache` (LRU memory + Redis) pattern already used for `limits` and `usage`. Cache key is `${orgId}`. Errors return a permissive `{ hasAccess: true }` fallback (existing behavior) and are also cached to prevent thundering-herd on billing outages.
