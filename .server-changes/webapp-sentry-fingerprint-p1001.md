---
area: webapp
type: improvement
---

Group Prisma P1001 ("Can't reach database server") errors into a single Sentry issue via a `beforeSend` fingerprint rule, so DB outages no longer fan out into hundreds of distinct issues that bury other alerts. Adds a small extensible rule table for future collapsing rules.
