# ClickHouse Package

`@internal/clickhouse` - ClickHouse client for analytics and observability data.

## Migrations

Goose-format SQL migrations live in `schema/`. Two rules below are load-bearing — both can block a deploy.

### Rule 1: number to `max + 1`, never slot in

Goose runs in strict mode in the deploy pipeline. If a migration file numbered *below* the version currently recorded in `goose_db_version` ever shows up, goose refuses to apply it and the deploy fails:

```
goose run: error: found 1 missing migrations before current version 30:
  version 29: 029_add_task_kind_to_task_runs_v2.sql
```

When adding a migration:

1. Look at `schema/` and take the largest existing number, call it `N`.
2. Name your file `0(N+1)_descriptive_name.sql`.
3. If you've been on a branch while main added migrations, **rebase and renumber** before opening the PR — a file numbered below the new max will block the next deploy after your PR merges.

### Rule 2: DDL must be idempotent

Migrations can be applied out of order in some environments (`goose up --allow-missing` for local recovery, manual fixups, etc.) and may be retried. Always use idempotent forms so a re-apply is a no-op:

```sql
-- +goose Up
ALTER TABLE trigger_dev.your_table
  ADD COLUMN IF NOT EXISTS new_column String DEFAULT '';

-- +goose Down
ALTER TABLE trigger_dev.your_table
  DROP COLUMN IF EXISTS new_column;
```

Equivalent forms for other DDL:

- `CREATE TABLE IF NOT EXISTS …`
- `DROP TABLE IF EXISTS …`
- `ADD INDEX IF NOT EXISTS …` / `DROP INDEX IF EXISTS …`
- `CREATE MATERIALIZED VIEW IF NOT EXISTS …` / `DROP VIEW IF EXISTS …`

ClickHouse supports `IF [NOT] EXISTS` on all of the above. Older migrations in this directory predate the rule and are not idempotent — leave them as-is unless you're explicitly hardening one.

## Naming Conventions

- `raw_` prefix for input tables (where data lands first)
- `_v1`, `_v2` suffixes for table versioning
- `_mv_v1` suffix for materialized views
- `_per_day`, `_per_month` for aggregation tables

See `README.md` in this directory for full naming convention documentation.

## Purpose

Stores time-series data for task run analytics, event streams, and performance metrics. Separate from PostgreSQL to handle high-volume writes from task execution.
