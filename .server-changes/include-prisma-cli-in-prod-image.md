---
area: webapp
type: fix
---

Fix database migrations failing to run in the production image because the Prisma CLI was missing from the build.
