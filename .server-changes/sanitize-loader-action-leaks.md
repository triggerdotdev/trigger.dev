---
area: webapp
type: fix
---

Expand API error response sanitization to additional loaders and actions so internal exception messages (Prisma errors, etc.) no longer leak to callers via 5xx response bodies.
