---
area: webapp
type: improvement
---

Wire `TRIGGER_MOLLIFIER_DRAIN_BATCH_SIZE` (default 50) so single-env bursts drain at the full `DRAIN_CONCURRENCY` budget per tick instead of one entry per tick.
