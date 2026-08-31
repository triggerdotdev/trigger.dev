---
area: webapp
type: fix
---

Runs waiting on triggerAndWait or batchTriggerAndWait can no longer get stuck forever when a database error interrupts a child run finishing (completing, failing, being canceled, or expiring). A durable guard now re-delivers the lost completion signal and resumes the waiting run automatically.
