---
area: webapp
type: fix
---

Fixes OTLP ingest endpoints returning HTTP 500 for runs on environments that use a Postgres-backed task event store. This caused the OpenTelemetry collector to drop entire span batches as non-retryable, resulting in real span loss.
