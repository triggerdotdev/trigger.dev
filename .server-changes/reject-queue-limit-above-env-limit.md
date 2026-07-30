---
area: webapp
type: breaking
---

Setting a queue concurrency limit higher than your environment limit is now rejected with an error instead of being silently reduced to the environment limit, so a queue never looks like it has more capacity than it can get. Limits already saved are unchanged.
