---
area: webapp
type: improvement
---

The runs list and the runs.list API are more resilient: a single expensive query can no longer slow the runs list down for everyone. The list now loads from a bounded recent time window, which keeps it fast at scale.
