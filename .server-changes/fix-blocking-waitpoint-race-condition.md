---
area: webapp
type: fix
---

Fix a race condition in the waitpoint system where a run could be blocked by a completed waitpoint but never be resumed because of an PostgreSQL MVCC issue. This was most likely to occur when creating a waitpoint via `wait.forToken()` at the exact same moment as completing the token with `wait.completeToken()`. Other types of waitpoints (timed, child runs) were not affected.
