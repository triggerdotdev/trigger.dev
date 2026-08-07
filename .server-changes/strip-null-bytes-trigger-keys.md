---
area: webapp
type: fix
---

Fixed a rare error where triggering a task could fail if the idempotency key or debounce key contained an invalid null character. The character is now removed automatically and the run is created as normal.
