---
area: webapp
type: fix
---

Hardening fixes for realtime sessions: stricter authorization on snapshot URLs and out-channel appends, environment-scoped message delivery for waiting runs, and idempotent appends via the X-Part-Id header. Session creation now rejects expired sessions, externalId can no longer be changed after creation, and the sessions list returns friendly run ids.
