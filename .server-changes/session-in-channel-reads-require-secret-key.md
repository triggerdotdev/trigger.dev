---
area: webapp
type: breaking
---

Reading a session's `.in` channel (`GET /realtime/v1/sessions/{id}/in` and `/in/records`) now requires a secret key. Public tokens, including `read:sessions:{id}`, get a 403; they can still read `.out` and append to `.in`.
