---
area: webapp
type: fix
---

Recover from ClickHouse `JSONEachRow` parse failures in the runs
replication path. `RunsReplicationService` now wraps its task-run and
payload inserts with the same reactive-sanitisation pattern used by
`ClickhouseEventRepository` since #3659: on `Cannot parse JSON object`,
sanitize lone UTF-16 surrogates across the batch (via the shared
`sanitizeRows` helper) and retry once. If the sanitiser found nothing
or the retry also fails, the batch is dropped, `permanentlyDroppedBatches`
increments, and a loud error log is emitted — preventing the surrounding
`#insertWithRetry` layer from spinning on the same deterministic
failure. Non-parse errors propagate unchanged.

Stops the bleeding behind the customer-visible "Tasks page shows a huge
Running count" symptom: one row with bad output JSON used to take down
the COMPLETED updates for its 50+ batch-mates, leaving every one of
them stranded in `EXECUTING` in ClickHouse forever (Postgres unaffected).
