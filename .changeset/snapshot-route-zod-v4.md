---
"@trigger.dev/core": patch
---

Fixes warm starts silently failing for deployments built with 4.6.0 to 4.6.3 in projects that resolve `zod` to a 3.x release. The runner could not parse the run handed to it by the warm-start service and exited, leaving the run waiting until the platform redrove it a few minutes later and started it cold. Redeploy to pick up the fix.
