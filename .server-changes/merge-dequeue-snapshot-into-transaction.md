---
area: webapp
type: improvement
---

Merge execution snapshot creation into the dequeue taskRun.update transaction, reducing 2 DB commits to 1 per dequeue operation
