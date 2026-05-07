# ClickHouse Package

`@internal/clickhouse` - ClickHouse client for analytics and observability data.

## Migrations

Goose-format SQL migrations live in `schema/`. Create new numbered files:

```sql
-- +goose Up
ALTER TABLE trigger_dev.your_table
ADD COLUMN new_column String DEFAULT '';

-- +goose Down
ALTER TABLE trigger_dev.your_table
DROP COLUMN new_column;
```

## Naming Conventions

- `raw_` prefix for input tables (where data lands first)
- `_v1`, `_v2` suffixes for table versioning
- `_mv_v1` suffix for materialized views
- `_per_day`, `_per_month` for aggregation tables

See `README.md` in this directory for full naming convention documentation.

## Purpose

Stores time-series data for task run analytics, event streams, and performance metrics. Separate from PostgreSQL to handle high-volume writes from task execution.
