---
area: webapp
type: feature
---

Scheduled runs and their descendants can be routed to a dedicated worker queue and processed by a separate worker fleet, isolating standard and agent run startup latency from scheduled-cron bursts. Off by default, enabled per organization via a feature flag.
