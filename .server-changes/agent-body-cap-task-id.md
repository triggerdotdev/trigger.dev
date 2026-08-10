---
area: webapp
type: fix
---

Triggering a task whose id contains "dashboard-agent" is no longer subject to the smaller chat request size limit, so larger payloads go through as expected.
