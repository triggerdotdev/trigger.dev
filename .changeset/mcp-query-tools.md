---
"@trigger.dev/core": patch
"trigger.dev": patch
---

MCP server improvements: new tools, bug fixes, and new flags.

**New tools:**
- `get_query_schema` — discover available TRQL tables and columns
- `query` — execute TRQL queries against your data
- `list_dashboards` — list built-in dashboards and their widgets
- `run_dashboard_query` — execute a single dashboard widget query
- `whoami` — show current profile, user, and API URL
- `list_profiles` — list all configured CLI profiles
- `switch_profile` — switch active profile for the MCP session
- `start_dev_server` — start `trigger dev` in the background and stream output
- `stop_dev_server` — stop the running dev server
- `dev_server_status` — check dev server status and view recent logs

**New API endpoints:**
- `GET /api/v1/query/schema` — query table schema discovery
- `GET /api/v1/query/dashboards` — list built-in dashboards

**New features:**
- `--readonly` flag hides write tools (`deploy`, `trigger_task`, `cancel_run`) so the AI cannot make changes
- `read:query` JWT scope for query endpoint authorization
- `get_run_details` trace output is now paginated with cursor support
- MCP tool annotations (`readOnlyHint`, `destructiveHint`) for all tools

**Bug fixes:**
- Fixed `search_docs` tool failing due to renamed upstream Mintlify tool (`SearchTriggerDev` → `search_trigger_dev`)
- Fixed `list_deploys` failing when deployments have null `runtime`/`runtimeVersion` fields (#3139)
- Fixed `list_preview_branches` crashing due to incorrect response shape access
- Fixed `metrics` table column documented as `value` instead of `metric_value` in query docs
- Fixed dev CLI leaking build directories on rebuild — deprecated workers now clean up their build dirs when their last run completes

**Context optimizations:**
- `get_query_schema` now requires a table name and returns only one table's schema (was returning all tables)
- `get_current_worker` no longer inlines payload schemas; use new `get_task_schema` tool instead
- Query results formatted as text tables instead of JSON (~50% fewer tokens)
- `cancel_run`, `list_deploys`, `list_preview_branches` formatted as text instead of raw JSON
- Schema and dashboard API responses cached to avoid redundant fetches
