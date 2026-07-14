---
area: webapp
type: fix
---

Fix intermittent unstyled/broken pages during rolling deploys, caused by stale HTML requesting `/build` asset hashes that 404 on the new image. Documents now default to `Cache-Control: no-cache` so browsers always revalidate HTML, and an inline script reloads the page (max twice) when a `/build` asset fails to load.
