---
area: webapp
type: fix
---

Fix intermittent unstyled/broken pages during rolling deploys, caused by stale HTML requesting `/build` asset hashes that 404 on the new image. Documents now default to `Cache-Control: no-cache`, and all responses carry an `X-Build-Id` header. A working page is never touched: when a Remix navigation reveals a new build, it becomes a full document load. Only real breakage (a `/build` asset 404 or failed chunk import) triggers recovery: an overlay goes up, the client polls the new `/build-version` endpoint and reloads once the server reports a different build (form fields and scroll are snapshotted and restored across the reload); if versions never diverge or the reload budget is spent, the overlay offers a manual reload.
