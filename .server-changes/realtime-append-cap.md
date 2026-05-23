---
area: webapp
type: fix
---

Session `.in/append` returns readable 413s on oversize bodies (was failing browser fetches as opaque `TypeError: Failed to fetch`) and now rejects only records that would actually exceed S2's per-record ceiling, instead of guessing at a conservative pre-encoding cap.
