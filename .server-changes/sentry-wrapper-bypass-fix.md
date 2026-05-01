---
area: webapp
type: fix
---

Stop nine catch sites in the webapp from escalating expected user-input
failures (`ServiceValidationError`, `OutOfEntitlementError`,
`CreateDeclarativeScheduleError`, `QueryError`) as `error`-level events.
Type-discriminate before logging; downgrade the user-facing branches to
`warn` while keeping unknown-error fall-throughs at `error`.
