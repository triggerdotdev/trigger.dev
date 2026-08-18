---
area: webapp
type: fix
---

Fixed a brief window after promoting or rolling back a deployment where newly triggered runs could still execute on the previous version. New runs now pick up the current version immediately.
