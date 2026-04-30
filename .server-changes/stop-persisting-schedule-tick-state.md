---
area: webapp
type: improvement
---

Stop writing per-tick state (`lastScheduledTimestamp`, `nextScheduledTimestamp`, `lastRunTriggeredAt`) on `TaskSchedule` and `TaskScheduleInstance`. The schedule engine now carries the previous fire time forward via the worker queue payload, eliminating ~270K dead-tuple-driven autovacuums per year on these hot tables and the associated `IO:XactSync` mini-spikes on the writer. Customer-facing `payload.lastTimestamp` semantics are unchanged.
