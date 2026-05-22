---
area: webapp
type: improvement
---

Drop `TRIGGER_MOLLIFIER_ENTRY_TTL_S` and the `entryTtlSeconds` option on `MollifierBuffer`. Buffer entries no longer auto-expire — the drainer is the only mechanism that removes them, which prevents silent run loss when the drainer is offline or falling behind. Default for `TRIGGER_MOLLIFIER_STALE_SWEEP_THRESHOLD_MS` is now an explicit 5 minutes (used to be half of the old entry TTL); set it directly if you want a different alerting horizon. See `_ops/mollifier-ops.md` for the new recovery flow.
