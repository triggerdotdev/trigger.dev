---
area: webapp
type: feature
---

App auto session logout. Users can configure their own session duration; org admins can set a `maxSessionDuration` cap that takes the tightest value across an account's orgs. Sessions exceeding their effective duration are redirected to `/logout` with a HIPAA audit trail emitted to CloudWatch (`event: session.auto_logout`). Enforcement reads `User.nextSessionEnd` — written at login and bulk-updated when admins change the cap — so the auth path adds no per-request DB queries.
