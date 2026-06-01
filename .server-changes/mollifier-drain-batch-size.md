---
area: webapp
type: improvement
---

Wire `TRIGGER_MOLLIFIER_DRAIN_BATCH_SIZE` (default 50) into the drainer so single-env bursts drain at the full `DRAIN_CONCURRENCY` budget instead of one pop per ~50ms tick. For a 20k-trigger burst on one env this cuts drain time from minutes to ~tens of seconds; smaller bursts (e.g. 50 on one env) drop from ~2.5s to ~50–100ms tail.
