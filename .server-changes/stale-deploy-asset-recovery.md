---
area: webapp
type: fix
---

Fix intermittent unstyled/broken pages during rolling deploys. Documents are content-hash-coupled to the build baked into the image that rendered them, so a stale document requests `/build` asset URLs that 404 on the new image (unstyled page, dead buttons from partial hydration). Three changes:

- Docker images now carry forward the previous published image's content-hashed `/build` assets (new `PREV_IMAGE` build arg, resolved in the publish workflow; no-op default for forks/local/self-hosted builds), pruned after 14 days — stale clients keep resolving their asset URLs across deploys.
- Document responses default to `Cache-Control: no-cache` so browsers always revalidate HTML.
- An inline recovery script in the document head force-reloads (at most twice, 30s apart) when a `/build` stylesheet/script fails to load or a dynamic chunk import rejects — covers rollbacks, retention-window overruns, and builds without a previous image.
