---
area: webapp
type: improvement
---

Move per-batch ClickHouse event-insert logs to the debug level to cut default log volume, and add an `HTTP_ACCESS_LOG_DISABLED` env var that suppresses successful (2xx) HTTP access logs while still logging errors.
