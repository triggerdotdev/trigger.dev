---
area: webapp
type: feature
---

Email the owner of a dashboard-created personal access token 7 days before it expires, and again when it has, so a CI deploy using it doesn't break by surprise. Set `PERSONAL_ACCESS_TOKEN_EXPIRY_EMAILS_ENABLED=false` to turn them off.
