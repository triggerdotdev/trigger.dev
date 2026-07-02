---
area: webapp
type: improvement
---

Rework the login page and SSO sign-in screens. On `/login`, SSO is now a
button (after Google) and email sign-in is an inline magic-link form under an
"or" divider that posts to the `/login/magic` action, reusing its existing
logic. `/login/magic` becomes confirmation-only and redirects to `/login`
otherwise, so the inline form is the single source of truth and old links
don't 404. `/login/sso` gets refreshed copy, an "Enterprise email address"
placeholder, and an "Ask about SSO" link. The Documentation link is removed
from the shared login layout. Both email fields validate inline with the
standard styled form error instead of the browser's native tooltip.
