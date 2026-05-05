---
area: webapp
type: improvement
---

Strip BackgroundWorker.metadata to the schedule slice read at deploy promotion, removing a 5+ second event-loop block in Prisma's client serializer when creating workers for projects with many tasks or source files.
