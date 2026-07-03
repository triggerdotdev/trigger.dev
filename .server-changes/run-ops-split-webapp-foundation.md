---
area: webapp
type: feature
---

Add the webapp foundation for the run-ops database split: topology/flag wiring, split-mode gating, a distinct-DB boot sentinel, and control-plane resolver read-through (all inert until `RUN_OPS_SPLIT_ENABLED`). The control-plane cache is now invalidated at env/org write sites (pause/resume, archive, concurrency/burst-factor, API-key regen, feature flags, rate limits, runs enable/disable, org/project delete, stream-basin provisioning) so admin/control-plane changes are reflected immediately rather than after the cache TTL, and the run-engine authenticated-env resolution goes through the cache-first, split-aware resolver.
