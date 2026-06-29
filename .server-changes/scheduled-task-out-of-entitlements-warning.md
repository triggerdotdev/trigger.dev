---
area: webapp
type: improvement
---

Treat a scheduled task trigger that fails because the organization is out of entitlements as an expected outcome: the schedule engine now logs it as a warning instead of an error, mirroring how environment queue-limit results are already handled.
