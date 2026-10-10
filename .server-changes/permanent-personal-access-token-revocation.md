---
area: webapp
type: fix
---

Revoking a personal access token is now permanent. Logging in with the CLI again issues a new token instead of reinstating the revoked one, so you can rotate a leaked CLI token by revoking it and running `trigger logout` then `trigger login`.
