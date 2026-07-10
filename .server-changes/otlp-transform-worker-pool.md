---
area: webapp
type: improvement
---

Optionally offload OTLP ingest processing (decode, transform, and LLM-cost enrichment) to a worker pool, freeing the main event loop under high telemetry volume. Off by default; opt in with the OTEL_TRANSFORM_WORKER_POOL_ENABLED environment variable.
