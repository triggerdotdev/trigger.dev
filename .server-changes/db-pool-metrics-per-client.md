---
area: webapp
type: improvement
---

Database connection-pool and query metrics are now reported for every configured database connection rather than only the primary, and keep working regardless of which database driver a connection uses. These metrics are now emitted only through the OpenTelemetry exporter; the Prometheus `/metrics` endpoint no longer includes the `prisma_*` series, so if you scrape that endpoint for database metrics, enable the OpenTelemetry metric exporter instead.
