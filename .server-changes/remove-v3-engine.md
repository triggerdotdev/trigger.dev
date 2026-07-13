---
area: webapp
type: breaking
---

Removed support for the end-of-life v3 engine. 4.5.0 is the last version we officially support for running v3, so instances or projects still on v3 must stay on 4.5.0 or upgrade to v4; v3 triggers, batch triggers, reschedules, and deploys now return a clear upgrade message instead of running.
