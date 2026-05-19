---
area: webapp
type: feature
---

Show the currently pinned `TRIGGER_VERSION` under the Atomic deployments toggle on the Vercel
integration settings, and prompt the user to clear it from Vercel production when they disable
atomic deployments. Also mark `TRIGGER_SECRET_KEY` writes to Vercel as `sensitive` so the value
cannot be read back from the Vercel dashboard or API once written.
