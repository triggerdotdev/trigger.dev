---
area: webapp
type: improvement
---

Throttle `PersonalAccessToken.lastAccessedAt` and `OrganizationAccessToken.lastAccessedAt` writes to at most once per 5 minutes per token. Eliminates ~95% of writes on two narrow hot tables that were autovacuuming every ~5 minutes — same denormalization-on-the-hot-path shape as the schedule engine fix in TRI-8891. The settings UI continues to display "last used" with at most 5-minute lag.
