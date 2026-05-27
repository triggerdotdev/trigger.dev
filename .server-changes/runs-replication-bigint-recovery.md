---
area: webapp
type: fix
---

Extend the runs-replication sanitizer (`sanitizeUnknownInPlace`) to detect
JS Numbers that JSON-serialise as bare integer tokens outside the
Int64..UInt64 range and replace them with their string form, so a
following retry insert no longer trips ClickHouse's
`INCORRECT_DATA` parser failure on `JSON(max_dynamic_paths)` columns.

This is the second class of poisoned-row failure that was stranding
`scan-social-profiles` runs in `EXECUTING` on the Tasks page even after
the UTF-16 surrogate fix (#3708 / TRI-9755). Root cause: upstream JS
Number precision loss on a 21-digit Google Plus ID
(`117039831458782873093` → `117039831458782870000`) — the precision-lossy
value still serialises as a bare integer that exceeds UInt64.MAX,
which CH's JSON column rejects with `Cannot parse JSON object here`.

Recovery stays purely reactive (no extra cost on the hot replication
path); the sanitizer only runs after a ClickHouse parse-error rejection.
