---
area: webapp
type: fix
---

Strip `secure` query parameter from QUERY_CLICKHOUSE_URL before passing to ClickHouse client. This was already done for the main and logs ClickHouse clients but was missing for the query client, causing a startup crash with `Error: Unknown URL parameters: secure`.
