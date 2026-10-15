---
area: webapp
type: fix
---

A `batchTriggerAndWait` could stay stuck executing after all of its child runs finished, if creating the batch was retried while the server was slow to respond. The parent now resumes with its child runs' results.
