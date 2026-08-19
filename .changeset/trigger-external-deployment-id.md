---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Pin runs to the deployment your calling code came from, so an old release never triggers tasks from a new one: set `TRIGGER_EXTERNAL_DEPLOYMENT_ID` to the id you deployed with, or `TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION=1` to detect the commit automatically on Vercel and most CI systems. Runs triggered before that deployment finishes building wait for it, then start pinned.
