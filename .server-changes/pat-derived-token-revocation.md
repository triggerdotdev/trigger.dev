---
area: webapp
type: fix
---

Revoking or expiring a personal access token now also ends the environment JWTs exchanged from it and the run, batch and session tokens minted with them.
