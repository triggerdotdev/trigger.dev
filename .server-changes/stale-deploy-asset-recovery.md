---
area: webapp
type: fix
---

Fix intermittent unstyled/broken pages during rolling deploys, caused by stale HTML requesting `/build` asset hashes that 404 on the new image. Docker images now carry forward the previous image's `/build` assets (`PREV_IMAGE` build arg, no-op for forks/self-hosted, 14-day retention), documents default to `Cache-Control: no-cache`, and an inline script reloads the page (max twice) when a `/build` asset fails to load.
