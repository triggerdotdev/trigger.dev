---
area: webapp
type: feature
---

The run queue can now schedule runs across concurrency key variants fairly, so one tenant or key with a large backlog can't starve runs waiting on other keys. This is opt-in via a flag and off by default, so nothing changes unless it's enabled.
