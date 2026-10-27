---
area: webapp
type: fix
---

Run metadata changes sent with an attempt's completion, such as increments and appends, are no longer applied a second time when a completion that already went through is retried.
