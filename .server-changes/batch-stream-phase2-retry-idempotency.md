---
area: webapp
type: fix
---

Stop spurious `BatchTriggerError` failures when a fast-completing `batchTrigger`/`batchTriggerAndWait` raced the stream finalisation - the API now treats these as successes instead of 422s.
