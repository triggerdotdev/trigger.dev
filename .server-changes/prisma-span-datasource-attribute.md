---
area: webapp
type: improvement
---

Tag Prisma spans with `db.datasource: "writer" | "replica"` so monitors and trace queries can distinguish the writer pool from the replica pool. Applies to all `prisma:engine:*` spans (including `prisma:engine:connection` used by the connection-pool monitors) and the outer `prisma:client:operation` span.
