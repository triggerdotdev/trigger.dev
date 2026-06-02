---
area: webapp
type: fix
---

Restore Postgres fallback for non-ClickHouse OTLP spans. Environments where runs carry a Postgres-backed taskEventStore (taskEvent / taskEventPartitioned) were receiving HTTP 500 from the OTLP ingest endpoints because the ClickHouse factory threw an error when passed those store values. The throw aborted the entire OTLP batch in #exportEvents. Non-ClickHouse stores are now routed directly to the Postgres eventRepository (matching the existing pattern in eventRepository/index.server.ts), and the ClickHouse factory call is wrapped in a try/catch that falls back to Postgres so any future unexpected store values degrade gracefully rather than failing the whole request.
