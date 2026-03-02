---
area: webapp
type: fix
---

Require the user is an admin during an impersonation session. Previously only the impersonation cookie was checked; now the real user's admin flag is verified on every request. If admin has been revoked, the session falls back to the real user's ID.
