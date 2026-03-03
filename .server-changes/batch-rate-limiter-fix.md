---
area: webapp
type: fix
---

Move batch queue global rate limiter from FairQueue claim phase to BatchQueue worker queue consumer for accurate per-item rate limiting. Add worker queue depth cap to prevent unbounded growth that could cause visibility timeouts.
