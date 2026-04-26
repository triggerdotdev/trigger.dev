---
area: webapp
type: feature
---

Add a "Back office" tab to `/admin` and a per-organization detail page at `/admin/back-office/orgs/:orgId`. The first action available on that page is editing the org's API rate limit: admins can save a `tokenBucket` override (refill rate, interval, max tokens) and see a plain-English preview of the resulting sustained rate and burst allowance. Writes are audit-logged via the server logger.
