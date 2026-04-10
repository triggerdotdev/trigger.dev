---
area: webapp
type: feature
---

Add an Agent view to the run details page for runs whose `taskKind` annotation is `AGENT`. The view renders the agent's `UIMessage` conversation by subscribing to the run's `chat` realtime stream — the same data source as the Agent Playground content view. Switching is via a `Trace view` / `Agent view` segmented control above the run body, and the selected view is reflected in the URL via `?view=agent` so it's shareable.
