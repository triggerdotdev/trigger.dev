---
area: webapp
type: fix
---

Deploying with an outdated CLI could produce an image that fails to start on every run. These deploys are now stopped before going live, with a message asking you to upgrade the CLI and re-deploy.
