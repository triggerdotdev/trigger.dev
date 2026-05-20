---
area: webapp
type: improvement
---

`/api/*` responses no longer leak Prisma "Can't reach database server" (P1001) errors when the database is unreachable — affected responses are rewritten to a generic Internal Server Error before reaching the client.
