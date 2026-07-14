---
area: webapp
type: fix
---

Fix intermittent unstyled/broken pages during rolling deploys, caused by stale HTML requesting `/build` asset hashes that 404 on the new image. Documents now default to `Cache-Control: no-cache` so browsers always revalidate HTML. On a `/build` asset failure, an inline script polls the new `/build-version` endpoint with backoff and reloads only once the server reports a different build than the page was rendered with; if versions never diverge or the reload budget is spent, it shows a manual-reload banner instead of leaving a dead page.
