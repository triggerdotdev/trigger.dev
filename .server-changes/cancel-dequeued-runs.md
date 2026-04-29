---
area: webapp
type: fix
---

Show the cancel button in the runs list for runs in `DEQUEUED` status. `DEQUEUED` was missing from `NON_FINAL_RUN_STATUSES` so the list hid the button even though the single run page allowed it.
