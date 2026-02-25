---
area: webapp
type: feature
---

Add Alerts 2.0: query-based alert definitions that evaluate TSQL queries against ClickHouse on a configurable schedule

Key components:
- `AlertV2Definition` Postgres model: stores query, conditions (JSON), evaluation interval, channel IDs, and current state
- `alert_evaluations_v1` ClickHouse table: records every evaluation result with state, value, and duration (90-day TTL)
- `scheduleAlertEvaluations` cron job (every minute): finds due definitions and enqueues individual evaluation jobs
- `evaluateAlertDefinition` worker job: executes the TSQL query with tenant isolation, evaluates thresholds, writes to ClickHouse, fires notifications on state change
- `ALERT_V2_FIRING` / `ALERT_V2_RESOLVED` alert types delivered via existing Slack, Email, and Webhook channels
- Global concurrency limit via the alerts worker prevents overwhelming ClickHouse
