---
area: webapp
type: improvement
---

Downgrade the "Google auth conflict" log from `error` to `warn`. This branch handles an expected user-state mismatch (Google ID belongs to one user, email is on another) by returning the existing auth user — there's no exception to chase, so it shouldn't page on the Sentry error channel.
