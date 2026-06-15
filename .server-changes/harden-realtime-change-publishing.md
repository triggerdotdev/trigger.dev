---
area: webapp
type: improvement
---

Harden the native realtime backend's run-change publishing so a publish can never throw into a run lifecycle operation and never buffers commands in memory during a pub/sub Redis outage.
