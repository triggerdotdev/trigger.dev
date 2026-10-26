---
area: webapp
type: fix
---

Deleting an organization now uninstalls its Vercel integration. A Vercel installation disabled on Vercel's side is reported as such instead of as an expired connection, and removing it no longer reports success.
