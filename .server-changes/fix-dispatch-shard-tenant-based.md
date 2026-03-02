---
area: webapp
type: feature
---

Two-level tenant dispatch architecture for batch queue processing. Replaces the
single master queue with a two-level index: a dispatch index (tenant → shard)
and per-tenant queue indexes (tenant → queues). This enables O(1) tenant
selection and fair scheduling across tenants regardless of queue count. Improves batch queue processing performance.
