---
area: webapp
type: improvement
---

Drop the first-batch mollifier-buffer scan from `BulkActionV2`. The action's confirmation count comes from ClickHouse (eventually consistent for PG-but-not-yet-replicated runs) and never included buffered runs, so processing buffered entries created a safety gap: a customer confirming "Replay ~0 runs" could see N buffered runs replayed they didn't know about. Bulk actions are now uniformly bound by what ClickHouse can see; buffered runs are picked up by subsequent bulk actions once they drain into PG → ClickHouse — matching the existing eventually-consistent contract for PG-not-yet-CH runs. Removes `bulkActionBuffer.server.ts` and its container-backed tests; the buffered-runs UX will be reimplemented when the global status indicator lands.
