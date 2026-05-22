---
area: webapp
type: feature
---

Periodic mollifier stale-entry sweep. Scans the buffer's queue ZSETs every `TRIGGER_MOLLIFIER_STALE_SWEEP_INTERVAL_MS` (default 5min); entries whose dwell exceeds `TRIGGER_MOLLIFIER_STALE_SWEEP_THRESHOLD_MS` (default half of `entryTtlSeconds`) emit a `mollifier.stale_entries` OTel counter tick plus a structured `mollifier.stale_entry` warning log. Read-only — the sweep does not remove or salvage entries; that decision is deferred to a separate retention-policy change. Gives ops a paging signal when the drainer is offline or falling behind before TTL-induced silent loss kicks in.
