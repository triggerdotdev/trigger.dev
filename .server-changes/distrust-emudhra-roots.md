---
area: webapp
type: fix
---

The webapp Docker image no longer trusts the root certificates that chain to the compromised eMudhra intermediate CAs, so connections to servers presenting certificates from those intermediates now fail.
