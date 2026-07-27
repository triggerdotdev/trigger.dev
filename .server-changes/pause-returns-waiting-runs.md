---
area: webapp
type: fix
---

Pausing a queue or an environment now also holds back runs that were already waiting to start. Previously those runs would still go ahead, so a pause could take effect a little later than expected.
