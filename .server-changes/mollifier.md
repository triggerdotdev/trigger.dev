---
area: webapp
type: feature
---

Mollifier — Redis-backed burst buffer in front of `engine.trigger` with a fair drainer, full read/write parity for buffered runs across the API + dashboard + realtime stream, alertable `mollifier.stale_entries.current` gauge for drainer health, and `runFailed` alerts on drainer-terminal `SYSTEM_FAILURE` rows.
