---
area: supervisor
type: fix
---

Runs no longer lose their worker's token when a concurrent delivery or a lost answer leaves a failed worker create's token behind: the worker that took the name keeps it, and a token nothing will use is cleaned up instead of being kept.
