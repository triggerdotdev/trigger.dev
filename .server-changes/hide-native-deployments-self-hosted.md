---
area: webapp
type: improvement
---

Hide native (Git-based) deployments in self-hosted instances. The dashboard and API now gate the native build server option and `enqueueBuild` API on the cloud build client availability. Self-hosted instances will use the CLI or GitHub Action for deployments instead.