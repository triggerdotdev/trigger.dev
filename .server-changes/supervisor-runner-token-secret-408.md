---
area: supervisor
type: fix
---

Runs no longer lose their worker's token when the cluster answers the worker's create with a 408, so the worker starts instead of waiting for a requeue.
