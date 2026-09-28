---
area: webapp
type: fix
---

Fixed a bug where a burst of telemetry could leave OpenTelemetry ingest rejecting every batch for a long time. Batches that wait too long are now dropped individually instead of restarting the processing workers, so ingest recovers as soon as the burst passes.
