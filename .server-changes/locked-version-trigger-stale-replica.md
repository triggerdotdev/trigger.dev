---
area: webapp
type: fix
---

Fix locked-version triggers such as triggerAndWait occasionally failing with "task not found on locked version" for a task that is actually registered, by confirming against the primary database when the read replica returns no row.
