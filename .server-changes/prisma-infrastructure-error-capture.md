---
area: webapp
type: fix
---

Log Prisma infrastructure errors (P1xxx) centrally and obfuscate their messages (which carry the DB hostname) on API responses that previously returned the raw message, without changing status codes or headers.
