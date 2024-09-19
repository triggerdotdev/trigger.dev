---
"trigger.dev": patch
---

Ignore OTEL_EXPORTER_OTLP_ENDPOINT environment variable from `.env` files, to prevent the internal OTEL_EXPORTER_OTLP_ENDPOINT being overwritten with a user-supplied value.
