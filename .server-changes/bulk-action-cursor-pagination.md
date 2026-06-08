---
area: webapp
type: fix
---

Fix run pagination that could duplicate or skip runs: the query orders by `(created_at, run_id)` but the cursor cut on `run_id` alone, which diverges when run_id order doesn't match created_at order (e.g. bulk replay re-processing runs). Cursors now encode the composite key as an opaque token and cut on the matching tuple; legacy bare-run_id cursors stay supported for in-flight pagination.
