---
area: webapp
type: fix
---

Stop leaking raw exception messages on 500 responses across webapp API routes; return a generic error string and log the full error server-side instead.
