---
area: webapp
type: fix
---

Run-scoped realtime streams written inside a chat session run now use the same streams backend as the session itself, instead of falling back to the older one.
